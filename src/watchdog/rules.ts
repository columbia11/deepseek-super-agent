import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface WatchdogRules {
  stuckMsDefault: number
  nudgeBeforeFail: boolean
  failAfterFailedJobs: number
  reasons: { stale: string; 'failed-jobs': string; 'goal-drift': string }
  /** Phrases a report can use to admit that it left the ticket's scope. */
  driftMarkers: string[]
  /**
   * Owner prose for the opt-in model drift check: what counts as drift. The
   * marker rules never read it. `rules.json` stores it as lines.
   */
  driftPolicy: string
}

const fallback: WatchdogRules = {
  stuckMsDefault: 60_000,
  nudgeBeforeFail: true,
  failAfterFailedJobs: 2,
  reasons: {
    stale: 'watchdog: stuck',
    'failed-jobs': 'watchdog: repeated job failures',
    'goal-drift': 'watchdog: report left the ticket scope',
  },
  driftMarkers: ['out of scope', 'unrelated to the ticket', 'different task', 'not what was asked'],
  driftPolicy: [
    'Drift means the report shows work, plans, or results outside the ticket\'s authorized scope.',
    'Reading, testing, or fixing something the ticket\'s own work depends on is in scope.',
    'A progress note, a blocker, or a question for the owner is not drift.',
    'Starting an unrelated task, widening the change beyond the scope, or acting on a request the ticket did not authorize is drift.',
    'When unsure, answer drift=false.',
  ].join('\n'),
}

/** A string or a list of lines; anything else, or only blank lines, keeps the default. */
function policyText(raw: unknown): string {
  const lines = typeof raw === 'string' ? [raw] : Array.isArray(raw) ? raw : []
  const text = lines.filter((line): line is string => typeof line === 'string').join('\n').trim()
  return text || fallback.driftPolicy
}

export function loadWatchdogRules(path = join(dirname(fileURLToPath(import.meta.url)), 'rules.json')): WatchdogRules {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<Omit<WatchdogRules, 'driftPolicy'>> & {
      driftPolicy?: unknown
    }
    return {
      stuckMsDefault: Number(raw.stuckMsDefault ?? fallback.stuckMsDefault),
      nudgeBeforeFail: raw.nudgeBeforeFail !== false,
      failAfterFailedJobs: Number(raw.failAfterFailedJobs ?? fallback.failAfterFailedJobs),
      reasons: {
        stale: raw.reasons?.stale ?? fallback.reasons.stale,
        'failed-jobs': raw.reasons?.['failed-jobs'] ?? fallback.reasons['failed-jobs'],
        'goal-drift': raw.reasons?.['goal-drift'] ?? fallback.reasons['goal-drift'],
      },
      driftMarkers: Array.isArray(raw.driftMarkers)
        ? raw.driftMarkers.filter((marker): marker is string => typeof marker === 'string' && marker.trim().length > 0)
        : fallback.driftMarkers,
      driftPolicy: policyText(raw.driftPolicy),
    }
  } catch {
    return { ...fallback, reasons: { ...fallback.reasons } }
  }
}
