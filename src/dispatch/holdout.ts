import fs from 'node:fs'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { UserError } from '../shared/errors.ts'

/** Upper bound for one pnpm install / typecheck / vitest run (and the coder) in serve. */
export const HOST_COMMAND_TIMEOUT_MS = 20 * 60 * 1000
const OUTPUT_CAP = 1_000_000

export interface HostCommandResult {
  status: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}

/**
 * Async child process with a hard timeout. Dispatch runs inside the serve
 * process, so a blocking spawnSync would freeze channels, outbox and watchdog.
 */
export function runHostCommandAsync(
  command: string,
  args: readonly string[],
  opts: { cwd: string; timeoutMs: number },
): Promise<HostCommandResult> {
  return new Promise(resolve => {
    let stdout = ''
    let stderr = ''
    let done = false
    const child = spawn(command, [...args], {
      cwd: opts.cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const finish = (status: number | null, timedOut: boolean): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve({ status, stdout, stderr, timedOut })
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      child.stdout.destroy()
      child.stderr.destroy()
      finish(null, true)
    }, opts.timeoutMs)
    child.stdout.on('data', (chunk: Buffer | string) => {
      if (stdout.length < OUTPUT_CAP) stdout += String(chunk)
    })
    child.stderr.on('data', (chunk: Buffer | string) => {
      if (stderr.length < OUTPUT_CAP) stderr += String(chunk)
    })
    child.on('error', error => {
      stderr += error.message
      finish(null, false)
    })
    child.on('close', code => finish(code, false))
  })
}

/** Offline unit suite aligned with `pnpm test:coverage` exclusions. */
export const OFFLINE_VITEST_EXCLUDE = [
  'test/live-demo.test.ts',
  'test/live-e2e.test.ts',
  'test/team-live.test.ts',
  'test/demos-real-channels.test.ts',
] as const

const GIT_LOCAL_ENV = { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } as const

async function runHostCommand(args: string[], cwd: string): Promise<{ ok: boolean; output: string }> {
  const r = await runHostCommandAsync('pnpm', args, { cwd, timeoutMs: HOST_COMMAND_TIMEOUT_MS })
  const timedOut = r.timedOut ? `timed out after ${HOST_COMMAND_TIMEOUT_MS} ms\n` : ''
  const output = `${timedOut}${r.stdout}${r.stderr}`.trim().slice(0, 12_000)
  return { ok: r.status === 0, output }
}

async function ensureNodeModules(workspace: string): Promise<void> {
  const nm = path.join(workspace, 'node_modules')
  if (fs.existsSync(nm)) return
  const install = await runHostCommandAsync('pnpm', ['install', '--frozen-lockfile'], {
    cwd: workspace,
    timeoutMs: HOST_COMMAND_TIMEOUT_MS,
  })
  if (install.status !== 0) {
    const why = install.timedOut ? `timed out after ${HOST_COMMAND_TIMEOUT_MS} ms` : install.stderr.trim().slice(0, 400)
    throw new UserError(`implementer: pnpm install failed: ${why}`)
  }
}

function listTestFilesAtRef(workspace: string, ref: string): Set<string> {
  const r = spawnSync('git', ['ls-tree', '-r', '--name-only', ref, '--', 'test/'], {
    cwd: workspace,
    encoding: 'utf8',
    env: GIT_LOCAL_ENV,
  })
  if (r.status !== 0) {
    throw new UserError(`implementer: could not list tests at ${ref}`)
  }
  const files = new Set<string>()
  for (const line of (r.stdout ?? '').split(/\r?\n/)) {
    const p = line.trim()
    if (p.endsWith('.test.ts') || p.endsWith('.test.tsx')) files.add(p)
  }
  return files
}

export function assertNoDeletedBaselineTests(workspace: string, baseHead: string): void {
  const atBase = listTestFilesAtRef(workspace, baseHead)
  for (const rel of atBase) {
    const abs = path.join(workspace, rel)
    if (!fs.existsSync(abs)) {
      throw new UserError(`implementer: refused publish — test file removed: ${rel}`)
    }
  }
}

export async function runImplementerHoldout(workspace: string, label: string): Promise<void> {
  await ensureNodeModules(workspace)
  const typecheck = await runHostCommand(['typecheck'], workspace)
  const vitestArgs = [
    'exec',
    'vitest',
    'run',
    ...OFFLINE_VITEST_EXCLUDE.flatMap(f => ['--exclude', f]),
  ]
  const tests = await runHostCommand(vitestArgs, workspace)
  if (!typecheck.ok || !tests.ok) {
    throw new UserError(
      `implementer: holdout failed ${label}: typecheck=${typecheck.ok} tests=${tests.ok}\n`
      + `${typecheck.output}\n${tests.output}`,
    )
  }
}

