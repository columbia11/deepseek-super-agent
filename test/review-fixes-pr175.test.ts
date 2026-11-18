import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseRepo } from '../src/channels/github-source.ts'
import { FeaturePrPublisher } from '../src/env/git-publish.ts'
import type { ToolRegistry } from '../src/harness/tools.ts'
import type { Runtime } from '../src/runtime.ts'
import { freshRuntime, shutdown } from './fixtures.ts'

const GIT_ENV = { ...process.env, GIT_CONFIG_NOSYSTEM: '1' }

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function refs(bare: string): string {
  return git(bare, 'for-each-ref', '--format=%(refname)')
}

function cleanup(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch {
    /* Windows may hold handles briefly */
  }
}

function writeHook(file: string, body: string): void {
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`.replace(/\r\n/g, '\n'), { mode: 0o755 })
  fs.chmodSync(file, 0o755)
}

describe('PR #175 review: host publisher must not run Worker-controlled git hooks/config', () => {
  it('Worker-planted hooks, fsmonitor and pushInsteadOf do not run or redirect on the host', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-agent-pr175-'))
    const slash = (p: string) => p.replace(/\\/g, '/')
    const marker = slash(path.join(root, 'host-marker.txt'))
    const legit = slash(path.join(root, 'legit.git'))
    const evil = slash(path.join(root, 'evil.git'))
    const ws = path.join(root, 'ws')
    const previousSecret = process.env.PROBE_HOST_SECRET
    process.env.PROBE_HOST_SECRET = 'host-only-secret'
    try {
      git(root, 'init', '--bare', '-q', '-b', 'main', legit)
      git(root, 'init', '--bare', '-q', '-b', 'main', evil)
      fs.mkdirSync(ws)
      git(ws, 'init', '-q', '-b', 'main')
      git(ws, 'config', 'user.email', 't@t.com')
      git(ws, 'config', 'user.name', 't')
      fs.writeFileSync(path.join(ws, 'README.md'), 'work\n')
      git(ws, 'add', 'README.md')
      git(ws, 'commit', '-q', '-m', 'work')
      const workerHead = git(ws, 'rev-parse', 'HEAD')

      // What a prompt-injected Worker can write inside its writable workspace.
      const hooks = path.join(ws, '.git', 'hooks')
      for (const name of ['pre-push', 'post-checkout', 'reference-transaction', 'pre-commit']) {
        writeHook(path.join(hooks, name), `echo "${name} ran on host secret=$PROBE_HOST_SECRET" >> '${marker}'`)
      }
      const fsmon = path.join(ws, 'fsmon.sh')
      writeHook(fsmon, `echo "fsmonitor ran on host secret=$PROBE_HOST_SECRET" >> '${marker}'`)
      git(ws, 'config', 'core.fsmonitor', slash(fsmon))
      git(ws, 'config', `url.${evil}.pushInsteadOf`, legit)

      const gh = vi.fn(async (args: string[]) => {
        if (args[1] === 'list') return '[]'
        if (args[1] === 'create') return 'https://github.com/o/r/pull/42\n'
        if (args[1] === 'view') return JSON.stringify({ number: 42, url: 'https://github.com/o/r/pull/42' })
        return ''
      })
      const pub = new FeaturePrPublisher({
        repo: parseRepo('o/r'),
        workspace: () => ws,
        pushRemote: legit,
        gh,
      })
      const result = await pub.publish({ workerId: 'w1', title: 'T', branch: 'feat' })

      const ran = fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8') : ''
      expect(ran).toBe('')
      expect(refs(evil)).toBe('')
      expect(result.branch).toBe('peanut/feat')
      expect(git(legit, 'rev-parse', 'refs/heads/peanut/feat')).toBe(workerHead)
      expect(refs(legit)).not.toContain('refs/heads/main')
      expect(gh).toHaveBeenCalledWith(expect.arrayContaining(['pr', 'create', '--head', 'peanut/feat']))
    } finally {
      if (previousSecret === undefined) delete process.env.PROBE_HOST_SECRET
      else process.env.PROBE_HOST_SECRET = previousSecret
      cleanup(root)
    }
  })

  it('refuses to publish a workspace with no commits', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-agent-pr175-'))
    try {
      const legit = path.join(root, 'legit.git')
      git(root, 'init', '--bare', '-q', '-b', 'main', legit)
      const ws = path.join(root, 'ws')
      fs.mkdirSync(ws)
      git(ws, 'init', '-q', '-b', 'peanut/empty')
      const gh = vi.fn(async () => '')
      const pub = new FeaturePrPublisher({ repo: parseRepo('o/r'), workspace: () => ws, pushRemote: legit, gh })
      await expect(pub.publish({ workerId: 'w1', title: 'T', branch: 'empty' })).rejects.toThrow(/no commits/)
      expect(gh).not.toHaveBeenCalled()
      expect(refs(legit)).toBe('')
    } finally {
      cleanup(root)
    }
  })
})

describe('PR #175 review: workspace seeding from a non-git cwd', () => {
  let runtime: Runtime | undefined

  afterEach(async () => {
    if (runtime) await shutdown(runtime)
    runtime = undefined
    vi.restoreAllMocks()
  })

  it('Runtime.create from a non-git cwd keeps Worker write_file/read_file working', async () => {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-agent-pr175-plain-'))
    try {
      const env = { ...process.env }
      delete env.DS_AGENT_WORKSPACE_SOURCE_REPO
      vi.spyOn(process, 'cwd').mockReturnValue(plain)
      runtime = freshRuntime({ allowMockModel: true, env })
      vi.restoreAllMocks()
      const tools = (runtime as unknown as { tools: ToolRegistry }).tools
      const session = { sessionId: 'w-plain', role: 'worker' as const }
      await tools.invoke({ id: 'c1', name: 'write_file', args: { path: 'a.txt', body: 'hello' } }, session)
      const read = await tools.invoke({ id: 'c2', name: 'read_file', args: { path: 'a.txt' } }, session) as { text: string }
      expect(read.text).toContain('hello')
    } finally {
      cleanup(plain)
    }
  })
})
