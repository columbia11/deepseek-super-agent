import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { imTrigger } from '../channels/im.ts'
import { MockModel } from '../harness/model.ts'
import { replyLatencies, summarizeCurve, type CurveSummary } from '../metrics/curve.ts'
import type { MetricName } from '../metrics/metrics.ts'
import { Runtime } from '../runtime.ts'
import type { Decision } from '../shared/types.ts'

/**
 * `pnpm bench:curve [--loads 1,2,4,8,16]`: T45 end-to-end latency against load.
 * Offline MockModel fixture on this machine, not a benchmark (docs/MODULES.md, T45).
 */

export const DEFAULT_CURVE_LOADS: readonly number[] = [1, 2, 4, 8, 16]
export const DEFAULT_CURVE_DEADLINE_MS = 60_000

export interface EndToEndCurveOptions {
  /** Triggers submitted together per level; deduplicated and sorted. Defaults to 1, 2, 4, 8, 16. */
  loads?: readonly number[]
  /** How long one level may wait for its replies. Defaults to 60 s. */
  deadlineMs?: number
  /**
   * Epoch milliseconds. Read at ingress, and by the Runtime (`RuntimeOptions.now`)
   * when it writes the reply's Outbox row. Must not go backwards.
   * Defaults to the monotonic performance clock.
   */
  clock?: () => number
}

export interface EndToEndLevel {
  load: number
  /** Triggers with no `result` reply in the Outbox when the level ended. */
  unanswered: number
  /** Ingress-to-Outbox milliseconds per answered Trigger, in submission order. */
  samples: number[]
  latency: CurveSummary
  /** The level's Runtime counters (model calls, Eval accepts, mesh placement). */
  counters: Record<MetricName, number>
}

/**
 * Each level submits `load` addressed IM Triggers on `load` distinct Threads at
 * once into a fresh Runtime under `<home>/load-<n>`, then waits for the jobs to
 * settle. A sample runs from just before `Runtime.ingest` to the `createdAt` of
 * that Trigger's `result` reply row in the Outbox: Ingress, Eval, Ticket, Router
 * and Worker turns, and the reply. Stores are closed; the caller owns `home`.
 */
export async function runEndToEndCurve(
  home: string,
  options: EndToEndCurveOptions = {},
): Promise<EndToEndLevel[]> {
  const deadlineMs = Number.isFinite(options.deadlineMs) && options.deadlineMs! > 0
    ? options.deadlineMs!
    : DEFAULT_CURVE_DEADLINE_MS
  const clock = options.clock ?? (() => performance.timeOrigin + performance.now())
  // Outbox rows carry ISO timestamps with whole milliseconds; ingress is truncated the same way.
  const ms = () => Math.floor(clock())
  const valid = (options.loads ?? []).map(Math.floor).filter(load => Number.isSafeInteger(load) && load > 0)
  const loads = valid.length ? [...new Set(valid)].sort((a, b) => a - b) : DEFAULT_CURVE_LOADS
  const levels: EndToEndLevel[] = []
  for (const load of loads) {
    levels.push(await runLevel(path.join(home, `load-${load}`), load, deadlineMs, ms))
  }
  return levels
}

async function runLevel(home: string, load: number, deadlineMs: number, ms: () => number): Promise<EndToEndLevel> {
  const runtime = Runtime.create({
    home,
    model: new MockModel(),
    // Operator DS_AGENT_* settings (allowlists, shards, mesh size, MCP servers) would change the workload.
    env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('DS_AGENT_'))),
    now: () => new Date(ms()).toISOString(),
    jobDelayMs: 0,
    watchdogIntervalMs: 60_000,
    stuckMs: 60_000,
  })
  const entered = new Map<string, number>()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    for (let index = 0; index < load; index++) {
      const id = `trg_curve_${load}_${index}`
      const at = ms()
      entered.set(id, at)
      runtime.ingest(imTrigger({
        id,
        thread: `curve/${load}-${index}`,
        text: `@ds-agent please fix the login timeout on checkout ${index}`,
        at: new Date(at).toISOString(),
      }))
    }
    await Promise.race([
      runtime.jobsSettled(),
      new Promise(resolve => {
        timer = setTimeout(resolve, deadlineMs)
      }),
    ])
    const samples = replyLatencies(entered, {
      decisions: runtime.store.listDocs<Decision>('decision'),
      replies: runtime.store.listReplies(),
      outbox: runtime.store.listOutbox(),
    })
    return {
      load,
      unanswered: load - samples.length,
      samples,
      latency: summarizeCurve(samples),
      counters: runtime.metrics.snapshot().counters,
    }
  } finally {
    if (timer) clearTimeout(timer)
    // Same teardown as bench:bakeoff: a level cut off by the deadline must not wait again.
    runtime.daemon.stop()
    if (runtime.store.isOpen) runtime.store.close()
  }
}

const entry = process.argv[1] ?? ''
if (entry.endsWith('latency-curve.ts') || entry.endsWith('latency-curve.js')) {
  const flag = process.argv.indexOf('--loads')
  const loads = flag >= 0 ? (process.argv[flag + 1] ?? '').split(',').map(Number) : undefined
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-agent-curve-'))
  try {
    const levels = await runEndToEndCurve(home, { loads })
    console.log(JSON.stringify({
      run: 'offline MockModel fixture on one machine; not a benchmark',
      node: process.version,
      platform: `${process.platform}-${process.arch}`,
      levels,
    }, null, 2))
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
}
