import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ProcessFillTarget } from '../src/env/fill-vault.ts'
import { wrapBashCommand } from '../src/env/seccomp.ts'
import { Runtime } from '../src/runtime.ts'
import { ScriptedModel } from './scripted-model.ts'

const created = vi.hoisted(() => [] as { root: string; options: unknown }[])

// Record what the Runtime hands to LocalEnv; behaviour is unchanged.
vi.mock('../src/env/local-env.ts', async importOriginal => {
  const mod = await importOriginal<typeof import('../src/env/local-env.ts')>()
  class RecordingLocalEnv extends mod.LocalEnv {
    constructor(root: string, options?: ConstructorParameters<typeof mod.LocalEnv>[1]) {
      super(root, options)
      created.push({ root, options })
    }
  }
  return { ...mod, LocalEnv: RecordingLocalEnv }
})

const dirs: string[] = []

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-agent-pr173-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  vi.restoreAllMocks()
  for (const dir of dirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      // Windows may hold a handle briefly; leftovers in tmp are harmless.
    }
  }
})

describe('PR #173 review fixes', () => {
  it('the default worker sandbox refuses to read the fill vault file on darwin and linux', () => {
    const vaultFile = '/home/owner/.ds-agent/vault.json'
    const policy = { enabled: true, writableRoots: ['/home/owner/.ds-agent/workspaces/w1'], denyReadPaths: [vaultFile] }

    const darwin = wrapBashCommand('base64 vault.json', policy, {
      platform: 'darwin',
      available: () => true,
      execPath: '/usr/local/bin/node',
    })
    const profile = darwin.argv[2]!
    const deny = `(deny file-read* (literal "${vaultFile}"))`
    expect(profile).toContain('(allow file-read*)')
    expect(profile).toContain(deny)
    // SBPL: the later rule wins, so the deny must follow the host-wide allow.
    expect(profile.indexOf(deny)).toBeGreaterThan(profile.indexOf('(allow file-read*)'))

    const linux = wrapBashCommand('base64 vault.json', policy, {
      platform: 'linux',
      available: () => true,
      exists: () => true,
    })
    const argv = linux.argv.join(' ')
    expect(argv).toContain('--ro-bind / /')
    expect(argv).toContain(`--ro-bind /dev/null ${vaultFile}`)
    // bwrap applies mounts in order: the mask must come after `/` and the writable roots.
    expect(argv.indexOf(`--ro-bind /dev/null ${vaultFile}`)).toBeGreaterThan(argv.indexOf('--bind /home/owner/.ds-agent/workspaces/w1'))
    expect(linux.argv.indexOf('--')).toBeGreaterThan(linux.argv.indexOf(vaultFile))

    // Strict read isolation keeps the mask too; an absent file is not bound (bwrap would fail).
    const strict = wrapBashCommand('true', { ...policy, readIsolation: true }, {
      platform: 'linux',
      available: () => true,
      exists: target => target !== vaultFile,
    })
    expect(strict.argv).not.toContain(vaultFile)
  })

  it('the Runtime denies the loaded fill vault file to worker bash', () => {
    const home = tempDir()
    const file = path.join(home, 'vault.json')
    fs.writeFileSync(file, JSON.stringify({
      fill: { visa: { kind: 'card', number: '4111111111111111', cvc: '123' } },
    }), { mode: 0o600 })
    fs.chmodSync(file, 0o600)
    // Windows cannot express `chmod 600` in stat().mode; present the mode the
    // POSIX owner would have set so the vault loads here as it does there.
    const realStat = fs.statSync
    vi.spyOn(fs, 'statSync').mockImplementation(((target: fs.PathLike, options?: fs.StatSyncOptions) => {
      const stat = realStat(target, options) as fs.Stats
      if (String(target) === file) stat.mode = (stat.mode & ~0o777) | 0o600
      return stat
    }) as typeof fs.statSync)
    created.length = 0
    const runtime = Runtime.create({
      home,
      model: new ScriptedModel(() => ({ text: 'ok' })),
      fillTarget: false,
      env: { PATH: process.env.PATH },
    })
    try {
      expect(runtime.log.text()).toContain('[fill] vault=entries=1')
      const workerEnv = created.find(entry => entry.root === path.join(home, 'workspaces'))
      expect(workerEnv).toBeDefined()
      expect((workerEnv!.options as { denyReadPaths?: string[] }).denyReadPaths).toContain(file)
    } finally {
      runtime.store.close()
    }
  })

  it('a failing fill helper that echoes its JSON stdin does not leak an escaped value', async () => {
    const value = 'Pa"ss\\w0rd-Secret'
    const failing = new ProcessFillTarget({
      command: process.execPath,
      args: ['-e', `let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{console.error('cannot parse input: '+s);process.exit(2)})`],
      label: 'failing-helper',
      timeoutMs: 5_000,
    })
    let message = ''
    try {
      await failing.fill('password', value)
    } catch (error) {
      message = String(error)
    }
    expect(message).toContain('fill helper failed (exit 2)')
    expect(message).not.toContain(value)
    expect(message).not.toContain(JSON.stringify(value).slice(1, -1))
    expect(message).not.toContain('w0rd-Secret')
  })
})
