import { UserError } from '../shared/errors.ts'
import { threadKey, type Disposition, type Thread, type Ticket, type Trigger } from '../shared/types.ts'
import type { Host } from './host.ts'

/**
 * Hand a fanned-out trigger back to Eval and drop this ticket's subscription.
 * The next human message on the thread must go through Intake → Eval again
 * (no bypass=subscription for this ticket).
 *
 * Only a follow-up that reached this ticket through actionable fan-out can be
 * handed back, once per ticket. The trigger is requeued when every ticket it
 * was fanned out to has handed it back, so Eval sees it at most once and never
 * opens a second ticket beside one that still holds it. Returns whether it was
 * requeued.
 */
export function handback(host: Host, ticketId: string, triggerId: string, reason: string): boolean {
  const disposition = host.repo.getDoc<Disposition>('disposition', triggerId)
  const trigger = host.repo.getDoc<Trigger>('trigger', triggerId)
  if (!disposition || !trigger) throw new UserError(`unknown trigger ${triggerId}`)
  // A filtered trigger never passed admission. Requeueing it would let Eval turn
  // it into a Ticket without a fresh admission decision, so refuse instead.
  if (disposition.filtered !== undefined) {
    throw new UserError(
      `trigger ${triggerId} was filtered (${disposition.filtered || 'filtered'}) and cannot be handed back without re-admission`,
    )
  }
  // A context-only delivery, the ticket's own origin, and another ticket's
  // follow-up did not skip Eval for this ticket. Requeueing one would evaluate
  // it twice and could open a duplicate ticket.
  if (!disposition.fanout.includes(ticketId)) {
    throw new UserError(`trigger ${triggerId} did not reach ticket ${ticketId} as a subscription follow-up`)
  }
  const prior = disposition.handbacks ?? []
  if (prior.some(item => item.ticketId === ticketId)) {
    host.log(`[subscribe] handback skipped ticketId=${ticketId} triggerId=${triggerId} reason=already-handed-back`)
    return false
  }
  const key = threadKey(trigger.threads[0]!)
  const thread = host.repo.getDoc<Thread>('thread', key)
  if (!thread) throw new UserError(`unknown thread ${key}`)

  const at = host.now()
  disposition.handbacks = [...prior, { ticketId, reason, at }]
  host.repo.putDoc('disposition', triggerId, disposition)
  const returned = new Set(disposition.handbacks.map(item => item.ticketId))
  const requeued = disposition.fanout.every(id => returned.has(id))

  thread.subscriptions = thread.subscriptions.filter(id => id !== ticketId)
  thread.contextOnly = (thread.contextOnly ?? []).filter(id => id !== ticketId)
  if (requeued && !thread.pending.includes(triggerId)) thread.pending.push(triggerId)
  host.repo.putDoc('thread', key, thread)
  if (requeued) host.onQueued?.(key, triggerId, thread.pending)

  const ticket = host.repo.getDoc<Ticket>('ticket', ticketId)
  if (ticket) {
    ticket.threadKeys = ticket.threadKeys.filter(item => item !== key)
    ticket.contextOnlyThreads = (ticket.contextOnlyThreads ?? []).filter(item => item !== key)
    host.repo.putDoc('ticket', ticketId, ticket)
  }

  host.log(
    `[subscribe] handback ticketId=${ticketId} triggerId=${triggerId} reason=${reason} unsubscribed=${key} requeued=${requeued}`,
  )
  if (requeued) host.repo.addEvent('trigger.requeued', { triggerId, ticketId, reason })
  host.repo.addEvent('subscription.removed', { ticketId, threadKey: key, reason: 'handback' })
  if (requeued) host.onRequeued?.(key, triggerId)
  return requeued
}
