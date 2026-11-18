import type { JournalEntry, SessionJournal } from '../harness/session.ts'
import type { Metrics } from '../metrics/metrics.ts'
import type { JobRow, SessionRow, Ticket } from '../shared/types.ts'
import type { Store } from '../store/sqlite.ts'
import type { DriftCheck, DriftMode } from './drift.ts'
import { loadWatchdogRules, type WatchdogRules } from './rules.ts'

export function stuckSessions(sessions: SessionRow[], nowMs: number, stuckMs: number): SessionRow[] {
  return sessions.filter(session =>
    session.role === 'worker'
    && session.status === 'running'
    && nowMs - Date.parse(session.heartbeat) > stuckMs)
}

export interface StuckAssignment {
  ticketId: string
  assignmentId: string
  sessionId: string
  reason: 'stale' | 'failed-jobs' | 'goal-drift'
}

/** A running assignment with no report, or two failed jobs, is the watchdog's signal. */
export function stuckAssignments(
  tickets: Ticket[],
  jobs: JobRow[],
  nowMs: number,
  stuckMs: number,
): StuckAssignment[] {
  const stuck: StuckAssignment[] = []
  for (const ticket of tickets) {
    if (ticket.ended) continue
    // A human pause or an owner approval wait is intentional idle time.
    if (ticket.collab?.paused) continue
    if (ticket.collab?.approvals?.some(approval => approval.status === 'pending')) continue
    const assignment = ticket.assignments.at(-1)
    if (!assignment || assignment.state !== 'running') continue
    const sessionId = assignment.workerSessionId ?? `worker_${ticket.id}`
    const failedJobs = jobs.filter(job => job.ticketId === ticket.id && job.status === 'failed').length
    if (failedJobs >= 2) {
      stuck.push({ ticketId: ticket.id, assignmentId: assignment.id, sessionId, reason: 'failed-jobs' })
      continue
    }
    // A progress report is a heartbeat, not an exemption. A worker that reports
    // "still working" and then hangs must still be detected.
    const reportedAt = Date.parse(assignment.report?.at ?? '')
    const started = Date.parse(assignment.startedAt ?? '')
    const lastSeen = Number.isFinite(reportedAt) ? reportedAt : started
    if (!Number.isFinite(lastSeen) || nowMs - lastSeen <= stuckMs) continue
    stuck.push({ ticketId: ticket.id, assignmentId: assignment.id, sessionId, reason: 'stale' })
  }
  return stuck
}

interface DriftCandidate {
  ticket: Ticket
  hit: StuckAssignment
  /** Latest report text. */
  text: string
}

/** Running, unpaused, not approval-held assignments with a latest report to check. */
function driftCandidates(tickets: Ticket[]): DriftCandidate[] {
  const candidates: DriftCandidate[] = []
  for (const ticket of tickets) {
    if (ticket.ended || ticket.collab?.paused) continue
    if (ticket.collab?.approvals?.some(approval => approval.status === 'pending')) continue
    const assignment = ticket.assignments.at(-1)
    if (!assignment || assignment.state !== 'running') continue
    const text = assignment.report?.text
    if (!text) continue
    candidates.push({
      ticket,
      hit: {
        ticketId: ticket.id,
        assignmentId: assignment.id,
        sessionId: assignment.workerSessionId ?? `worker_${ticket.id}`,
        reason: 'goal-drift',
      },
      text,
    })
  }
  return candidates
}

/** True when a report uses one of the configured drift admissions. */
function markerDrift(text: string, rules: WatchdogRules): boolean {
  const lower = text.toLowerCase()
  return rules.driftMarkers.some(marker => lower.includes(marker.toLowerCase()))
}

/**
 * Rule-based goal drift (T43/T44): a running assignment whose latest report
 * explicitly says it left the ticket's scope. This is deliberately marker-based
 * so it cannot punish ordinary progress reports.
 */
export function driftAssignments(tickets: Ticket[], rules: WatchdogRules): StuckAssignment[] {
  return driftCandidates(tickets)
    .filter(candidate => markerDrift(candidate.text, rules))
    .map(candidate => candidate.hit)
}

export interface WatchdogControl {
  /** Watchdog-originated failure, so `watchdog.fail` is not confused with executor failures. */
  watchdogFail(ticketId: string, reason: string): {
    surfaced: boolean
    verdict: 'deliver' | 'discard' | 'hold'
  }
}

export class Watchdog {
  private readonly nudged = new Set<string>()
  /** One drift nudge per assignment; a later report is a new signal only via `nudged`. */
  private readonly drifted = new Set<string>()
  /** Opt-in model mode: the verdict for each running assignment's latest report text. */
  private readonly judged = new Map<string, { text: string; drift?: boolean }>()
  private readonly judging = new Set<Promise<void>>()
  private readonly rules: WatchdogRules

  constructor(private readonly opts: {
    store: Store
    engine: WatchdogControl
    journal: SessionJournal
    log: (line: string) => void
    metrics: Metrics
    intervalMs: number
    stuckMs: number
    /** Terminal-path callback for a speculative workdir (promote on deliver, delete on discard). */
    settle?: (sessionId: string, verdict: 'deliver' | 'discard' | 'hold') => void
    now?: () => number
    /** Opt-in model drift check. Absent keeps marker-only drift. */
    drift?: DriftCheck
  }) {
    this.rules = loadWatchdogRules()
  }

  get intervalMs(): number {
    return this.opts.intervalMs
  }

  get driftMode(): DriftMode {
    return this.opts.drift ? 'model' : 'rules'
  }

  /** Resolves when every in-flight model drift judgement has settled. */
  async driftSettled(): Promise<void> {
    await Promise.allSettled([...this.judging])
  }

  tick(): void {
    if (!this.opts.store.isOpen) return
    const db = this.opts.store.health()
    const now = this.opts.now?.() ?? Date.now()
    const tickets = this.opts.store.listDocs<Ticket>('ticket')
    const stuck = stuckAssignments(tickets, this.opts.store.listJobs(), now, this.opts.stuckMs)
    const drift = (this.opts.drift
      ? this.judgedDrift(this.opts.drift, tickets, stuck)
      : driftAssignments(tickets, this.rules))
      .filter(hit => !stuck.some(other => other.assignmentId === hit.assignmentId))
    const hits = [...stuck, ...drift]
    this.opts.log(`[watchdog] tick db=${db} stuck=${stuck.length} drift=${drift.length}`)
    if (hits.length === 0) {
      this.opts.metrics.increment('watchdog.idle')
    }
    const handled = new Set<string>()
    for (const hit of hits) {
      handled.add(hit.sessionId)
      handled.add(hit.ticketId)
      if (hit.reason === 'goal-drift') this.nudgeDrift(hit)
      else if (hit.reason === 'failed-jobs' || this.nudged.has(hit.assignmentId)) this.fail(hit)
      else this.nudge(hit)
    }
    // A human pause and an owner approval wait are both intentional idle time.
    // The stale running session row on either must not be nudged every tick.
    const idleTickets = new Set(
      this.opts.store.listDocs<Ticket>('ticket')
        .filter(ticket =>
          ticket.collab?.paused
          || ticket.collab?.approvals?.some(approval => approval.status === 'pending'))
        .map(ticket => ticket.id),
    )
    for (const session of stuckSessions(this.opts.store.listSessions(), now, this.opts.stuckMs)) {
      if (handled.has(session.id) || (session.ticketId != null && handled.has(session.ticketId))) continue
      if (session.ticketId && idleTickets.has(session.ticketId)) continue
      this.opts.journal.append(session.id, {
        role: 'user',
        kind: 'nudge',
        content: `watchdog nudge ticketId=${session.ticketId ?? ''}`,
      })
      this.opts.log(`[watchdog] nudge session=${session.id} ticketId=${session.ticketId ?? ''}`)
      this.opts.metrics.increment('watchdog.nudge')
    }
  }

  /**
   * Opt-in model drift (T43). Each new report text is judged once in the
   * background, and the verdict acts on a later tick through the same one-shot
   * drift nudge as the markers. The model only chooses nudge or no action.
   */
  private judgedDrift(check: DriftCheck, tickets: Ticket[], stuck: StuckAssignment[]): StuckAssignment[] {
    const hits: StuckAssignment[] = []
    const live = new Set<string>()
    for (const candidate of driftCandidates(tickets)) {
      const { assignmentId } = candidate.hit
      if (this.drifted.has(assignmentId) || stuck.some(other => other.assignmentId === assignmentId)) continue
      live.add(assignmentId)
      const entry = this.judged.get(assignmentId)
      if (entry?.text !== candidate.text) this.judge(check, candidate)
      else if (entry.drift) hits.push(candidate.hit)
    }
    // Verdicts belong to running assignments only; drop the rest.
    for (const assignmentId of this.judged.keys()) {
      if (!live.has(assignmentId)) this.judged.delete(assignmentId)
    }
    return hits
  }

  private judge(check: DriftCheck, candidate: DriftCandidate): void {
    const { ticket, text } = candidate
    const entry: { text: string; drift?: boolean } = { text }
    this.judged.set(candidate.hit.assignmentId, entry)
    const question = {
      title: ticket.title ?? '',
      brief: ticket.brief ?? '',
      scope: ticket.mandate?.scope ?? '',
      report: text,
    }
    const run = check.decide(question, this.rules.driftPolicy, markerDrift(text, this.rules))
      .then(outcome => {
        // If a newer report or an ended assignment dropped this entry, the write is inert.
        entry.drift = outcome.drift
        this.opts.log(
          `[watchdog] drift judged ticketId=${ticket.id} drift=${outcome.drift} via=${outcome.via}`
          + (outcome.reason ? ` reason=${outcome.reason}` : ''),
        )
      })
      .catch(() => {})
      .finally(() => this.judging.delete(run))
    this.judging.add(run)
  }

  private nudge(hit: StuckAssignment): void {
    this.nudged.add(hit.assignmentId)
    const entry: JournalEntry = {
      role: 'user',
      kind: 'nudge',
      content: `watchdog nudge ticketId=${hit.ticketId}`,
    }
    this.opts.journal.append(hit.sessionId, { ...entry })
    this.opts.store.addEvent('watchdog.nudge', {
      ticketId: hit.ticketId,
      assignmentId: hit.assignmentId,
      sessionId: hit.sessionId,
    })
    this.opts.log(`[watchdog] nudge session=${hit.sessionId} ticketId=${hit.ticketId}`)
    this.opts.metrics.increment('watchdog.nudge')
  }

  private nudgeDrift(hit: StuckAssignment): void {
    if (this.drifted.has(hit.assignmentId)) return
    this.drifted.add(hit.assignmentId)
    this.opts.journal.append(hit.sessionId, {
      role: 'user',
      kind: 'nudge',
      content: `watchdog drift ticketId=${hit.ticketId}`,
    })
    this.opts.store.addEvent('watchdog.nudge', {
      ticketId: hit.ticketId,
      assignmentId: hit.assignmentId,
      sessionId: hit.sessionId,
      reason: 'goal-drift',
    })
    this.opts.log(`[watchdog] drift nudge session=${hit.sessionId} ticketId=${hit.ticketId}`)
    this.opts.metrics.increment('watchdog.nudge')
  }

  private fail(hit: StuckAssignment): void {
    this.nudged.delete(hit.assignmentId)
    const text = hit.reason === 'failed-jobs' ? this.rules.reasons['failed-jobs'] : this.rules.reasons.stale
    const result = this.opts.engine.watchdogFail(hit.ticketId, text)
    // A watchdog fail is a terminal path: roll back the speculative workdir too.
    this.opts.settle?.(hit.sessionId, result.verdict)
    this.opts.store.addEvent('watchdog.fail', {
      ticketId: hit.ticketId,
      assignmentId: hit.assignmentId,
    })
    this.opts.log(`[watchdog] fail ticketId=${hit.ticketId}`)
  }
}