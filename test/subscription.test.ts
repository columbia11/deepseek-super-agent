import { afterEach, describe, expect, it, vi } from 'vitest'
import { imTrigger } from '../src/channels/im.ts'
import { arbitrateSubscribers, bypassEligible } from '../src/core/intake.ts'
import { bindRolePorts } from '../src/core/role-ports.ts'
import { currentTurn, MockModel, type Completion, type CompletionRequest } from '../src/harness/model.ts'
import { workerSessionId } from '../src/harness/session.ts'
import { ToolRegistry } from '../src/harness/tools.ts'
import type { AssessmentOutcome, EnvPort } from '../src/shared/ports.ts'
import { UserError } from '../src/shared/errors.ts'
import type { Decision, Disposition, Thread, Ticket, Trigger } from '../src/shared/types.ts'
import type { Runtime } from '../src/runtime.ts'
import { freshRuntime, shutdown, tempHome } from './fixtures.ts'
import { field, lastPrompt, ScriptedModel, silentModel } from './scripted-model.ts'

let runtime: Runtime | undefined

afterEach(async () => {
  if (runtime) await shutdown(runtime)
  runtime = undefined
})

/** IM trigger with an explicit channel-address group; admission reads only that field. */
function groupTrigger(input: {
  id: string
  thread: string
  text: string
  group?: string
  actor?: string
}): Trigger {
  const base = imTrigger({
    id: input.id,
    thread: input.thread,
    text: input.text,
    actor: input.actor,
  })
  return {
    ...base,
    channel: {
      source: 'im',
      thread: input.thread,
      ...(input.group ? { address: { group: input.group } } : {}),
    },
  }
}

describe('subscription bypass', () => {
  it('fans a same-thread follow-up out with bypass=subscription and does not open a second ticket', async () => {
    runtime = freshRuntime()
    expect(runtime.ingest(imTrigger({
      id: 'trg_noise',
      thread: 'topic/chatter',
      text: 'lol nice weather today haha',
      addressed: false,
    }))).toBe('filtered')
    expect(runtime.ingest(imTrigger({
      id: 'trg_login',
      thread: 'topic/bug-login',
      text: '@ds-agent please fix the login timeout on checkout',
    }))).toBe('stored')
    expect(runtime.ingest(imTrigger({
      id: 'trg_login_2',
      thread: 'topic/bug-login',
      text: '@ds-agent login still 500, the timeout is back',
    }))).toBe('stored')

    const tickets = runtime.store.listDocs<{ id: string; threadKeys: string[] }>('ticket')
    expect(tickets).toHaveLength(1)
    const ticketId = tickets[0]!.id
    const text = runtime.log.text()
    expect(text).toContain(`bypass=subscription ticketId=${ticketId}`)
    expect(text).toContain('ticketId=')
    const thread = runtime.store.getDoc<Thread>('thread', 'im:topic/bug-login')
    expect(thread?.pending).toEqual([])
    expect(thread?.subscriptions).toEqual([ticketId])
    const accepts = runtime.store.listDocs<Decision>('decision').filter(decision => decision.kind === 'accept')
    expect(accepts).toHaveLength(1)
    await runtime.finish()
  })

  it('bot/CI context reaches the existing Ticket and still becomes a new-work candidate', async () => {
    runtime = freshRuntime()
    expect(runtime.ingest(imTrigger({
      id: 'trg_login',
      thread: 'topic/bug-login',
      text: '@ds-agent please fix the login timeout on checkout',
    }))).toBe('stored')
    const original = runtime.store.listDocs<Ticket>('ticket')[0]!
    expect(runtime.ingest({
      ...imTrigger({
        id: 'trg_ci',
        thread: 'topic/bug-login',
        text: 'CI failed: login timeout on checkout is still broken',
        addressed: false,
      }),
      human: false,
      actor: { source: 'github', id: 'ci-bot' },
    })).toBe('stored')

    // A bot event is context for the live Ticket (it does not wake its Executor),
    // and it independently enters Eval as a new-work candidate.
    const disposition = runtime.store.getDoc<Disposition>('disposition', 'trg_ci')
    expect(disposition?.fanout).toEqual([])
    expect(disposition?.context).toEqual([original.id])
    expect(runtime.log.text()).not.toContain('bypass=subscription')
    const kept = runtime.store.getDoc<Ticket>('ticket', original.id)
    expect(kept?.inputs.some(input => input.triggerId === 'trg_ci' && input.kind === 'context')).toBe(true)
    expect(kept?.ended).toBeUndefined()
    expect(runtime.store.listDocs<Ticket>('ticket')).toHaveLength(2)
    await runtime.finish()
  })

  it('reject-ended-mandate: a follow-up does not bypass or resume an ended ticket', async () => {
    runtime = freshRuntime()
    expect(runtime.ingest(imTrigger({
      id: 'trg_login',
      thread: 'topic/bug-login',
      text: '@ds-agent please fix the login timeout on checkout',
    }))).toBe('stored')
    const original = runtime.store.listDocs<Ticket>('ticket')[0]!
    runtime.engine.report(original.id, { kind: 'ready', text: 'fixed', deliver: true })
    expect(runtime.ingest(imTrigger({
      id: 'trg_login_2',
      thread: 'topic/bug-login',
      text: '@ds-agent login still 500, the timeout is back',
    }))).toBe('stored')

    const ended = runtime.store.getDoc<Ticket>('ticket', original.id)
    expect(ended?.ended).toMatchObject({ outcome: 'ready', by: 'executor' })
    expect(ended?.inputs.some(input => input.triggerId === 'trg_login_2')).toBe(false)
    const disposition = runtime.store.getDoc<Disposition>('disposition', 'trg_login_2')
    expect(disposition?.fanout ?? []).not.toContain(original.id)
    expect(runtime.log.text()).not.toContain(`bypass=subscription ticketId=${original.id}`)
    await runtime.finish()
  })

  it('rejects a follow-up when the mandate scope is blank', async () => {
    runtime = freshRuntime()
    expect(runtime.ingest(imTrigger({
      id: 'trg_login',
      thread: 'topic/bug-login',
      text: '@ds-agent please fix the login timeout on checkout',
    }))).toBe('stored')
    const original = runtime.store.listDocs<Ticket>('ticket')[0]!
    original.mandate = { ...original.mandate, scope: '   ' }
    runtime.store.putDoc('ticket', original.id, original)
    expect(runtime.ingest(imTrigger({
      id: 'trg_login_2',
      thread: 'topic/bug-login',
      text: '@ds-agent login still 500, the timeout is back',
    }))).toBe('stored')

    const disposition = runtime.store.getDoc<Disposition>('disposition', 'trg_login_2')
    expect(disposition?.fanout).toEqual([])
    expect(runtime.store.getDoc<Ticket>('ticket', original.id)?.inputs.some(input => input.triggerId === 'trg_login_2')).toBe(false)
    expect(runtime.log.text()).not.toContain('bypass=subscription')
    await runtime.finish()
  })

  it('handback unsubscribes so the next human message goes through Eval', async () => {
    runtime = freshRuntime()
    expect(runtime.ingest(imTrigger({
      id: 'trg_login',
      thread: 'topic/bug-login',
      text: '@ds-agent please fix the login timeout on checkout',
    }))).toBe('stored')
    const ticket = runtime.store.listDocs<Ticket>('ticket')[0]!
    expect(runtime.ingest(imTrigger({
      id: 'trg_login_2',
      thread: 'topic/bug-login',
      text: '@ds-agent login still 500, the timeout is back',
    }))).toBe('stored')
    expect(runtime.log.text()).toContain(`bypass=subscription ticketId=${ticket.id}`)
    expect(runtime.store.getDoc<Thread>('thread', 'im:topic/bug-login')?.subscriptions).toEqual([ticket.id])

    expect(runtime.engine.handback(ticket.id, 'trg_login_2', 'not-our-bug')).toBe(true)
    const thread = runtime.store.getDoc<Thread>('thread', 'im:topic/bug-login')!
    expect(thread.subscriptions).toEqual([])
    expect(thread.pending).toContain('trg_login_2')
    expect(runtime.store.getDoc<Ticket>('ticket', ticket.id)?.threadKeys).not.toContain('im:topic/bug-login')
    expect(runtime.log.text()).toContain('unsubscribed=im:topic/bug-login')
    expect(runtime.store.listEvents().some(event => event.type === 'subscription.removed')).toBe(true)

    // Drain the requeued trigger through Eval (opens a fresh ticket). A later follow-up must not fan out to the old one.
    runtime.engine.evaluateDue()
    const afterHandback = runtime.store.listDocs<Ticket>('ticket').map(item => item.id)
    expect(afterHandback).toContain(ticket.id)
    expect(afterHandback.length).toBeGreaterThan(1)
    expect(runtime.ingest(imTrigger({
      id: 'trg_login_3',
      thread: 'topic/bug-login',
      text: '@ds-agent still broken after handback',
    }))).toBe('stored')
    const disposition = runtime.store.getDoc<Disposition>('disposition', 'trg_login_3')
    expect(disposition?.fanout ?? []).not.toContain(ticket.id)
    expect(runtime.store.getDoc<Ticket>('ticket', ticket.id)?.inputs.some(input => input.triggerId === 'trg_login_3')).toBe(false)
    await runtime.finish()
  })

  it('refuses handback for a filtered trigger: no requeue and no ticket', async () => {
    runtime = freshRuntime({ admission: { groups: ['eng'] } })
    expect(runtime.ingest(groupTrigger({
      id: 'trg_admitted',
      thread: 'topic/bug-login',
      group: 'eng',
      text: '@ds-agent please fix the login timeout on checkout',
    }))).toBe('stored')
    const ticket = runtime.store.listDocs<Ticket>('ticket')[0]!
    const before = runtime.store.listDocs<Ticket>('ticket').length
    const subscriptions = runtime.store.getDoc<Thread>('thread', 'im:topic/bug-login')!.subscriptions

    expect(runtime.ingest(groupTrigger({
      id: 'trg_denied',
      thread: 'topic/bug-login',
      group: 'random',
      text: '@ds-agent please fix the login timeout on checkout',
    }))).toBe('filtered')
    expect(runtime.store.getDoc<Disposition>('disposition', 'trg_denied')?.filtered)
      .toBe('fast:group-not-allowlisted')

    const engine = runtime.engine
    expect(() => engine.handback(ticket.id, 'trg_denied', 'probe')).toThrow(UserError)
    const thread = runtime.store.getDoc<Thread>('thread', 'im:topic/bug-login')!
    expect(thread.pending).not.toContain('trg_denied')
    expect(thread.subscriptions).toEqual(subscriptions)
    runtime.engine.evaluateDue()
    expect(runtime.store.listDocs<Ticket>('ticket')).toHaveLength(before)
    await runtime.finish()
  })

  it('skips an already-queued filtered id in evaluateDue', async () => {
    runtime = freshRuntime({ admission: { groups: ['eng'] } })
    expect(runtime.ingest(groupTrigger({
      id: 'trg_denied',
      thread: 'topic/bug-login',
      group: 'random',
      text: '@ds-agent please fix the login timeout on checkout',
    }))).toBe('filtered')

    // Simulate a stale pending entry left by an older process.
    const key = 'im:topic/bug-login'
    runtime.store.putDoc('thread', key, {
      key,
      ref: { source: 'im', id: 'topic/bug-login' },
      createdAt: '2026-10-31T00:00:00.000Z',
      subscriptions: [],
      correlated: [],
      pending: ['trg_denied'],
      meta: {},
    } satisfies Thread)

    expect(runtime.engine.evaluateDue()).toEqual([])
    expect(runtime.store.getDoc<Thread>('thread', key)?.pending).toEqual([])
    expect(runtime.store.listDocs<Ticket>('ticket')).toHaveLength(0)
    expect(runtime.store.listDocs<Decision>('decision')).toHaveLength(0)
    expect(runtime.log.text()).toContain('Evals.skip-filtered')
    await runtime.finish()
  })

  it('still requeues and evaluates an admitted trigger through handback', async () => {
    runtime = freshRuntime()
    expect(runtime.ingest(imTrigger({
      id: 'trg_login',
      thread: 'topic/bug-login',
      text: '@ds-agent please fix the login timeout on checkout',
    }))).toBe('stored')
    const ticket = runtime.store.listDocs<Ticket>('ticket')[0]!
    expect(runtime.ingest(imTrigger({
      id: 'trg_login_2',
      thread: 'topic/bug-login',
      text: '@ds-agent login still 500, the timeout is back',
    }))).toBe('stored')

    expect(runtime.engine.handback(ticket.id, 'trg_login_2', 'not-our-bug')).toBe(true)
    const requeued = runtime.store.getDoc<Thread>('thread', 'im:topic/bug-login')!
    expect(requeued.pending).toContain('trg_login_2')
    expect(requeued.subscriptions).toEqual([])

    runtime.engine.evaluateDue()
    const tickets = runtime.store.listDocs<Ticket>('ticket')
    expect(tickets.length).toBeGreaterThan(1)
    expect(tickets.some(item => item.originTriggerId === 'trg_login_2')).toBe(true)
    await runtime.finish()
  })

  it('many-to-many: every live subscriber receives the same human follow-up', async () => {
    let clock = Date.parse('2026-10-31T00:00:00.000Z')
    // Fan-out is the subject here; the Worker turns are incidental. A live
    // model explores the checkout bug for minutes, so script them instead of
    // letting model latency decide whether this assertion fits a timeout.
    runtime = freshRuntime({ model: silentModel(), now: () => new Date(clock += 1000).toISOString() })
    expect(runtime.ingest(imTrigger({
      id: 'trg_a',
      thread: 'topic/shared',
      text: '@ds-agent please fix the login timeout on checkout',
    }))).toBe('stored')
    expect(runtime.ingest(imTrigger({
      id: 'trg_b',
      thread: 'topic/other',
      text: '@ds-agent please fix the payment timeout on checkout',
    }))).toBe('stored')
    const tickets = runtime.store.listDocs<Ticket>('ticket')
    const older = tickets.find(item => item.originTriggerId === 'trg_a')
    const newer = tickets.find(item => item.originTriggerId === 'trg_b')
    expect(older).toBeDefined()
    expect(newer).toBeDefined()
    runtime.engine.subscribe(newer!.id, 'im:topic/shared')

    expect(runtime.ingest(imTrigger({
      id: 'trg_recent',
      thread: 'topic/shared',
      text: '@ds-agent login still 500, the timeout is back',
    }))).toBe('stored')
    const fanout = runtime.store.getDoc<Disposition>('disposition', 'trg_recent')?.fanout ?? []
    expect(fanout.sort()).toEqual([older!.id, newer!.id].sort())
    expect(runtime.log.text()).toContain(`bypass=subscription ticketId=${newer!.id}`)
    expect(runtime.log.text()).toContain(`bypass=subscription ticketId=${older!.id}`)
    expect(runtime.store.getDoc<Ticket>('ticket', older!.id)?.inputs.some(input => input.triggerId === 'trg_recent')).toBe(true)
    expect(runtime.store.getDoc<Ticket>('ticket', newer!.id)?.inputs.some(input => input.triggerId === 'trg_recent')).toBe(true)

    const ended = runtime.store.getDoc<Ticket>('ticket', newer!.id)!
    ended.ended = { at: '2026-10-31T00:00:09.000Z', outcome: 'ready', by: 'executor' }
    runtime.store.putDoc('ticket', ended.id, ended)
    expect(runtime.ingest(imTrigger({
      id: 'trg_active',
      thread: 'topic/shared',
      text: '@ds-agent please fix the login timeout again',
    }))).toBe('stored')
    expect(runtime.store.getDoc<Disposition>('disposition', 'trg_active')?.fanout).toEqual([older!.id])
    expect(runtime.store.getDoc<Ticket>('ticket', newer!.id)?.inputs.some(input => input.triggerId === 'trg_active')).toBe(false)
    await runtime.finish()
  })
})

describe('handback', () => {
  const key = 'im:topic/bug-login'

  function login(id: string, text = '@ds-agent login still 500, the timeout is back'): Trigger {
    return imTrigger({ id, thread: 'topic/bug-login', text })
  }

  function ticketFrom(rt: Runtime, triggerId: string): Ticket | undefined {
    return rt.store.listDocs<Ticket>('ticket').find(ticket => ticket.originTriggerId === triggerId)
  }

  /** Let the post-commit evaluation queued by a handback run. */
  const settled = (): Promise<void> => new Promise(resolve => setImmediate(resolve))

  it('refuses a trigger that did not reach the ticket as a fan-out follow-up', async () => {
    runtime = freshRuntime({ model: silentModel() })
    expect(runtime.ingest(login('trg_login', '@ds-agent please fix the login timeout on checkout'))).toBe('stored')
    expect(runtime.ingest(imTrigger({
      id: 'trg_pay',
      thread: 'topic/payments',
      text: '@ds-agent please fix the payment timeout on checkout',
    }))).toBe('stored')
    const loginTicket = ticketFrom(runtime, 'trg_login')!
    const payTicket = ticketFrom(runtime, 'trg_pay')!
    runtime.engine.subscribe(payTicket.id, key, { contextOnly: true })
    expect(runtime.ingest(login('trg_login_2'))).toBe('stored')
    expect(runtime.store.getDoc<Disposition>('disposition', 'trg_login_2'))
      .toMatchObject({ fanout: [loginTicket.id], context: [payTicket.id] })
    const before = runtime.store.getDoc<Thread>('thread', key)

    const engine = runtime.engine
    // Its own origin went through Eval; it never bypassed it.
    expect(() => engine.handback(loginTicket.id, 'trg_login', 'probe')).toThrow(/did not reach ticket/)
    // A context-only delivery never woke the ticket.
    expect(() => engine.handback(payTicket.id, 'trg_login_2', 'probe')).toThrow(/did not reach ticket/)
    // Another ticket's trigger.
    expect(() => engine.handback(loginTicket.id, 'trg_pay', 'probe')).toThrow(UserError)

    expect(runtime.store.getDoc<Thread>('thread', key)).toEqual(before)
    for (const id of ['trg_login', 'trg_login_2', 'trg_pay']) {
      expect(runtime.store.getDoc<Disposition>('disposition', id)?.handbacks).toBeUndefined()
    }
    expect(runtime.store.listEvents().some(event => event.type === 'trigger.requeued')).toBe(false)
    await runtime.finish()
  })

  it('evaluates a handed-back trigger once, into a new ticket that cannot hand it back again', async () => {
    runtime = freshRuntime({ model: silentModel() })
    expect(runtime.ingest(login('trg_login', '@ds-agent please fix the login timeout on checkout'))).toBe('stored')
    const original = ticketFrom(runtime, 'trg_login')!
    expect(runtime.ingest(login('trg_login_2'))).toBe('stored')

    const engine = runtime.engine
    expect(engine.handback(original.id, 'trg_login_2', 'not-our-bug')).toBe(true)
    expect(engine.handback(original.id, 'trg_login_2', 'again')).toBe(false)
    expect(runtime.store.getDoc<Thread>('thread', key)?.pending).toEqual(['trg_login_2'])

    // No further ingest: the Runtime evaluates the requeued trigger after the commit.
    await settled()
    const fresh = ticketFrom(runtime, 'trg_login_2')
    expect(fresh).toBeDefined()
    expect(fresh!.id).not.toBe(original.id)
    expect(runtime.store.getDoc<Thread>('thread', key)).toMatchObject({ pending: [], subscriptions: [fresh!.id] })

    // Neither a late repeat nor the new ticket returning its own origin requeues it.
    expect(engine.handback(original.id, 'trg_login_2', 'again')).toBe(false)
    expect(() => engine.handback(fresh!.id, 'trg_login_2', 'bounce')).toThrow(/did not reach ticket/)
    await settled()
    expect(runtime.store.getDoc<Thread>('thread', key)?.pending).toEqual([])
    expect(runtime.store.getDoc<Disposition>('disposition', 'trg_login_2')?.handbacks).toHaveLength(1)
    expect(runtime.store.listDocs<Decision>('decision')
      .filter(decision => decision.triggerIds.includes('trg_login_2'))
      .map(decision => decision.kind)).toEqual(['accept'])
    expect(runtime.store.listEvents().filter(event => event.type === 'trigger.requeued')).toHaveLength(1)
    await runtime.finish()
  })

  it('requeues a shared follow-up only after every ticket it reached hands it back', async () => {
    runtime = freshRuntime({ model: silentModel() })
    const shared = 'im:topic/shared'
    expect(runtime.ingest(imTrigger({
      id: 'trg_a',
      thread: 'topic/shared',
      text: '@ds-agent please fix the login timeout on checkout',
    }))).toBe('stored')
    expect(runtime.ingest(imTrigger({
      id: 'trg_b',
      thread: 'topic/other',
      text: '@ds-agent please fix the payment timeout on checkout',
    }))).toBe('stored')
    const first = ticketFrom(runtime, 'trg_a')!
    const second = ticketFrom(runtime, 'trg_b')!
    runtime.engine.subscribe(second.id, shared)
    expect(runtime.ingest(imTrigger({
      id: 'trg_shared',
      thread: 'topic/shared',
      text: '@ds-agent the invoice export is broken too',
    }))).toBe('stored')
    expect(runtime.store.getDoc<Disposition>('disposition', 'trg_shared')?.fanout.sort())
      .toEqual([first.id, second.id].sort())

    // The second ticket still holds it, so Eval must not open a duplicate yet.
    expect(runtime.engine.handback(first.id, 'trg_shared', 'not mine')).toBe(false)
    await settled()
    expect(runtime.store.getDoc<Thread>('thread', shared)).toMatchObject({ subscriptions: [second.id], pending: [] })
    expect(ticketFrom(runtime, 'trg_shared')).toBeUndefined()
    expect(runtime.store.listEvents().some(event => event.type === 'trigger.requeued')).toBe(false)

    expect(runtime.engine.handback(second.id, 'trg_shared', 'not mine either')).toBe(true)
    await settled()
    const fresh = ticketFrom(runtime, 'trg_shared')
    expect(fresh).toBeDefined()
    expect(runtime.store.getDoc<Thread>('thread', shared)).toMatchObject({ subscriptions: [fresh!.id], pending: [] })

    // Neither ticket that returned it gets the thread's next follow-up.
    expect(runtime.ingest(imTrigger({
      id: 'trg_next',
      thread: 'topic/shared',
      text: '@ds-agent the invoice export still fails',
    }))).toBe('stored')
    expect(runtime.store.getDoc<Disposition>('disposition', 'trg_next')?.fanout).toEqual([fresh!.id])
    await runtime.finish()
  })

  it('rolls back a handback that fails part-way', async () => {
    runtime = freshRuntime({ model: silentModel() })
    expect(runtime.ingest(login('trg_login', '@ds-agent please fix the login timeout on checkout'))).toBe('stored')
    const ticket = ticketFrom(runtime, 'trg_login')!
    expect(runtime.ingest(login('trg_login_2'))).toBe('stored')

    const store = runtime.store
    const addEvent = store.addEvent.bind(store)
    const spy = vi.spyOn(store, 'addEvent').mockImplementation((type, payload) => {
      if (type === 'subscription.removed') throw new Error('disk full')
      addEvent(type, payload)
    })
    const engine = runtime.engine
    expect(() => engine.handback(ticket.id, 'trg_login_2', 'not-our-bug')).toThrow('disk full')
    spy.mockRestore()
    await settled()

    expect(store.getDoc<Thread>('thread', key)).toMatchObject({ subscriptions: [ticket.id], pending: [] })
    expect(store.getDoc<Ticket>('ticket', ticket.id)?.threadKeys).toContain(key)
    expect(store.getDoc<Disposition>('disposition', 'trg_login_2')?.handbacks).toBeUndefined()
    expect(store.listEvents().some(event => event.type === 'trigger.requeued')).toBe(false)
    expect(ticketFrom(runtime, 'trg_login_2')).toBeUndefined()

    expect(engine.handback(ticket.id, 'trg_login_2', 'not-our-bug')).toBe(true)
    await runtime.finish()
  })

  it('keeps a committed handback across a restart', async () => {
    const home = tempHome()
    const first = freshRuntime({ home, model: silentModel() })
    // Engine commands only, so no Worker turn is in flight when the process stops.
    first.engine.receive(login('trg_login', '@ds-agent please fix the login timeout on checkout'))
    first.engine.evaluateDue()
    const ticket = ticketFrom(first, 'trg_login')!
    first.engine.receive(login('trg_login_2'))
    expect(first.engine.handback(ticket.id, 'trg_login_2', 'not-our-bug')).toBe(true)
    // Stop before the post-commit evaluation runs.
    first.daemon.stop()
    first.store.close()
    await settled()

    runtime = freshRuntime({ home, model: silentModel() })
    expect(runtime.store.getDoc<Thread>('thread', key)).toMatchObject({ subscriptions: [], pending: ['trg_login_2'] })
    expect(runtime.store.getDoc<Ticket>('ticket', ticket.id)?.threadKeys).not.toContain(key)
    expect(runtime.store.getDoc<Disposition>('disposition', 'trg_login_2')?.handbacks)
      .toMatchObject([{ ticketId: ticket.id, reason: 'not-our-bug' }])
    expect(runtime.engine.handback(ticket.id, 'trg_login_2', 'again')).toBe(false)

    runtime.flushEvals()
    expect(ticketFrom(runtime, 'trg_login_2')).toBeDefined()
    expect(runtime.store.getDoc<Thread>('thread', key)?.pending).toEqual([])
    await runtime.finish()
  })

  it('exposes handback_trigger to the Executor only, for its own ticket', async () => {
    runtime = freshRuntime({ model: silentModel() })
    expect(runtime.ingest(login('trg_login', '@ds-agent please fix the login timeout on checkout'))).toBe('stored')
    expect(runtime.ingest(imTrigger({
      id: 'trg_pay',
      thread: 'topic/payments',
      text: '@ds-agent please fix the payment timeout on checkout',
    }))).toBe('stored')
    const loginTicket = ticketFrom(runtime, 'trg_login')!
    const payTicket = ticketFrom(runtime, 'trg_pay')!
    expect(runtime.ingest(login('trg_login_2'))).toBe('stored')
    const tools = new ToolRegistry({
      store: runtime.store,
      ports: bindRolePorts(runtime.engine),
      env: {} as EnvPort,
      metrics: runtime.metrics,
      redact: text => text,
      log: () => {},
      scheduleJob: () => {},
      routerTurn: async () => {},
    })
    expect((await tools.specsFor('worker')).map(tool => tool.name)).toContain('handback_trigger')
    expect((await tools.specsFor('router')).map(tool => tool.name)).not.toContain('handback_trigger')
    expect((await tools.specsFor('watchdog')).map(tool => tool.name)).not.toContain('handback_trigger')

    const call = (args: Record<string, unknown>) => ({ id: 'call_handback', name: 'handback_trigger', args })
    const asWorker = (ticketId?: string) => ({
      sessionId: workerSessionId(ticketId ?? 'none'),
      role: 'worker' as const,
      ...(ticketId ? { ticketId } : {}),
    })
    await expect(tools.invoke(call({ triggerId: 'trg_login_2' }), { sessionId: 'router_default', role: 'router' }))
      .rejects.toThrow(/not available to router/)
    await expect(tools.invoke(call({ triggerId: 'trg_login_2' }), { sessionId: 'watchdog', role: 'watchdog' }))
      .rejects.toThrow(/not available to watchdog/)
    await expect(tools.invoke(call({ triggerId: 'trg_login_2' }), asWorker())).rejects.toThrow(/needs a ticket/)
    await expect(tools.invoke(call({}), asWorker(loginTicket.id))).rejects.toThrow(/needs a triggerId/)
    // Another Worker cannot return this ticket's follow-up, even by naming the ticket.
    await expect(tools.invoke(call({ triggerId: 'trg_login_2', ticketId: loginTicket.id }), asWorker(payTicket.id)))
      .rejects.toThrow(/did not reach ticket/)
    expect(runtime.store.getDoc<Thread>('thread', key)?.subscriptions).toEqual([loginTicket.id])

    await expect(tools.invoke(
      call({ triggerId: 'trg_login_2', reason: 'billing,\nnot login' }),
      asWorker(loginTicket.id),
    )).resolves.toEqual({ requeued: true, ticketId: loginTicket.id, triggerId: 'trg_login_2' })
    expect(runtime.store.getDoc<Disposition>('disposition', 'trg_login_2')?.handbacks)
      .toMatchObject([{ ticketId: loginTicket.id, reason: 'billing, not login' }])
    await runtime.finish()
  })

  it('end to end: the Executor hands an unrelated follow-up back and Eval opens a new ticket', async () => {
    const model = new HandbackModel()
    runtime = freshRuntime({ model, allowMockModel: true })
    expect(runtime.ingest(login('trg_login', '@ds-agent please fix the login timeout on checkout'))).toBe('stored')
    const original = ticketFrom(runtime, 'trg_login')!
    expect(runtime.ingest(login('trg_invoice', '@ds-agent separately, the invoice export is broken'))).toBe('stored')
    expect(runtime.log.text()).toContain(`bypass=subscription ticketId=${original.id} thread=${key} triggerId=trg_invoice`)

    // The Worker read triggerId from its FOLLOWUP prompt and handed it back; the
    // Runtime evaluated it without waiting for another ingest.
    await within(model.handedBack, 10_000)
    await settled()
    const fresh = ticketFrom(runtime, 'trg_invoice')
    expect(fresh).toBeDefined()
    expect(fresh!.id).not.toBe(original.id)
    await runtime.jobsSettled()

    expect(model.results(original.id)).toEqual([
      { requeued: true, ticketId: original.id, triggerId: 'trg_invoice' },
      { requeued: false, ticketId: original.id, triggerId: 'trg_invoice' },
    ])
    // The new ticket's Executor cannot bounce its own origin back to Eval.
    expect(model.results(fresh!.id)).toEqual([
      { error: `trigger trg_invoice did not reach ticket ${fresh!.id} as a subscription follow-up` },
    ])
    const text = runtime.log.text()
    expect(text).toContain(`[subscribe] handback ticketId=${original.id} triggerId=trg_invoice`)
    expect(text).toContain(`Evals.batch thread=${key} size=1 triggerIds=trg_invoice`)
    expect(text).toContain(`ExecutorSession=${workerSessionId(fresh!.id)} ticketId=${fresh!.id}`)
    expect(runtime.store.listDocs<Ticket>('ticket')).toHaveLength(2)
    expect(runtime.store.listDocs<Decision>('decision')
      .filter(decision => decision.triggerIds.includes('trg_invoice'))
      .map(decision => [decision.kind, decision.ticketId])).toEqual([['accept', fresh!.id]])
    expect(runtime.store.getDoc<Thread>('thread', key)).toMatchObject({ subscriptions: [fresh!.id], pending: [] })
    expect(runtime.store.getDoc<Ticket>('ticket', original.id)?.threadKeys).not.toContain(key)
    await runtime.finish()
  })
})

/**
 * MockModel, except that a Worker hands back the follow-up about invoices
 * (twice, so the repeat shows up) and the first ticket Eval opens for it tries
 * to hand its own origin back. That bounce is tried once in total, so a broken
 * guard fails the assertions instead of looping. Every other turn is MockModel.
 */
class HandbackModel extends MockModel {
  private readonly seen: { ticketId: string; content: string }[] = []
  private bounced = false
  private resolveHandedBack: () => void = () => {}
  readonly handedBack = new Promise<void>(resolve => {
    this.resolveHandedBack = resolve
  })

  results(ticketId: string): unknown[] {
    return this.seen.filter(item => item.ticketId === ticketId).map(item => JSON.parse(item.content) as unknown)
  }

  override async complete(request: CompletionRequest): Promise<Completion> {
    const prompt = lastPrompt(request)
    const followup = prompt.startsWith('FOLLOWUP') && field(prompt, 'text').includes('invoice')
    const task = prompt.startsWith('TASK') && field(prompt, 'brief').includes('invoice')
    if (request.role !== 'worker' || (!followup && !task)) return super.complete(request)
    const ticketId = field(prompt, 'ticketId')
    const last = request.messages.at(-1)
    if (last?.role === 'tool' && last.name === 'handback_trigger') this.seen.push({ ticketId, content: last.content })
    const done = currentTurn(request.messages)
      .filter(message => message.role === 'tool' && message.name === 'handback_trigger').length
    if (followup ? done < 2 : !this.bounced) {
      if (!followup) this.bounced = true
      return {
        toolCalls: [{
          id: `call_handback_${done}`,
          name: 'handback_trigger',
          args: { triggerId: followup ? field(prompt, 'triggerId') : 'trg_invoice', reason: 'invoices are not the login bug' },
        }],
      }
    }
    if (!followup) return super.complete(request)
    this.resolveHandedBack()
    return { text: 'handed back' }
  }
}

async function within(promise: Promise<void>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`not settled within ${ms}ms`)), ms)
  })
  try {
    await Promise.race([promise, deadline])
  } finally {
    clearTimeout(timer)
  }
}

describe('filtered triggers cannot be resurrected', () => {
  const key = 'im:topic/bug-login'

  function seedFiltered(id = 'trg_denied'): void {
    expect(runtime!.ingest(groupTrigger({
      id,
      thread: 'topic/bug-login',
      group: 'random',
      text: '@ds-agent please fix the login timeout on checkout',
    }))).toBe('filtered')
  }

  function seedDeferred(pending: string[]): void {
    runtime!.store.putDoc('thread', key, {
      key,
      ref: { source: 'im', id: 'topic/bug-login' },
      createdAt: '2026-10-31T00:00:00.000Z',
      subscriptions: [],
      correlated: [],
      pending,
      deferred: true,
      meta: {},
    } satisfies Thread)
  }

  function acceptOutcome(): AssessmentOutcome {
    return { kind: 'accept', reason: 'probe', title: 'Probe', scope: 'probe the report' }
  }

  function acceptModel(): ScriptedModel {
    return new ScriptedModel(() => ({
      text: JSON.stringify({
        kind: 'accept',
        reason: 'filtered regression',
        title: 'Fix login',
        scope: 'fix the login timeout',
      }),
    }))
  }

  it('clears a filtered-only deferred queue during Runtime.start assessment', async () => {
    runtime = freshRuntime({ model: silentModel(), admission: { groups: ['eng'] } })
    seedFiltered()
    seedDeferred(['trg_denied'])

    runtime.start()
    await runtime.assessmentsSettled()

    const thread = runtime.store.getDoc<Thread>('thread', key)!
    expect(thread.pending).toEqual([])
    expect(thread.deferred).toBe(false)
    expect(runtime.store.listDocs<Ticket>('ticket')).toHaveLength(0)
    expect(runtime.store.listDocs<Decision>('decision')).toHaveLength(0)
    expect(runtime.log.text()).toContain('assess.skip-filtered')
    await runtime.finish()
  })

  it('treats an empty filtered reason as a denial for handback and eval', async () => {
    runtime = freshRuntime({ admission: { groups: ['eng'] } })
    seedFiltered()
    const disposition = runtime.store.getDoc<Disposition>('disposition', 'trg_denied')!
    disposition.filtered = ''
    runtime.store.putDoc('disposition', 'trg_denied', disposition)
    seedDeferred(['trg_denied'])

    const engine = runtime.engine
    expect(() => engine.handback('ticket_probe', 'trg_denied', 'probe')).toThrow(UserError)
    expect(engine.evaluateDue()).toEqual([])
    expect(runtime.store.getDoc<Thread>('thread', key)?.pending).toEqual([])
    expect(runtime.store.listDocs<Ticket>('ticket')).toHaveLength(0)
    await runtime.finish()
  })

  it('commitAssessed refuses a filtered id and creates nothing', async () => {
    runtime = freshRuntime({ admission: { groups: ['eng'] } })
    seedFiltered()
    seedDeferred(['trg_denied'])

    expect(runtime.engine.commitAssessed(key, ['trg_denied'], acceptOutcome())).toBeUndefined()
    expect(runtime.store.listDocs<Ticket>('ticket')).toHaveLength(0)
    expect(runtime.store.listDocs<Decision>('decision')).toHaveLength(0)
    // Refusal happens before any queue mutation.
    expect(runtime.store.getDoc<Thread>('thread', key)?.pending).toEqual(['trg_denied'])
    await runtime.finish()
  })

  it('decide refuses a filtered trigger and creates nothing', async () => {
    runtime = freshRuntime({ admission: { groups: ['eng'] } })
    seedFiltered()
    seedDeferred(['trg_denied'])

    const engine = runtime.engine
    expect(() => engine.decide('trg_denied', acceptOutcome())).toThrow(UserError)
    expect(() => engine.decide('trg_denied', acceptOutcome())).toThrow(/filtered.*re-admission/)
    expect(runtime.store.listDocs<Ticket>('ticket')).toHaveLength(0)
    expect(runtime.store.listDocs<Decision>('decision')).toHaveLength(0)
    await runtime.finish()
  })

  it('keeps an admitted neighbor when assessment clears a filtered id', async () => {
    runtime = freshRuntime({ model: acceptModel(), admission: { groups: ['eng'] } })
    runtime.engine.receive(groupTrigger({
      id: 'trg_admitted',
      thread: 'topic/bug-login',
      group: 'eng',
      text: '@ds-agent please fix the login timeout on checkout',
    }))
    seedFiltered()
    seedDeferred(['trg_denied', 'trg_admitted'])

    runtime.start()
    await runtime.assessmentsSettled()

    const thread = runtime.store.getDoc<Thread>('thread', key)!
    expect(thread.pending).toEqual([])
    expect(thread.deferred).toBe(false)
    const tickets = runtime.store.listDocs<Ticket>('ticket')
    expect(tickets).toHaveLength(1)
    expect(tickets[0]!.originTriggerId).toBe('trg_admitted')
    expect(runtime.store.listDocs<Decision>('decision').some(decision =>
      decision.triggerIds.includes('trg_denied'))).toBe(false)
    await runtime.finish()
  })

  it('evaluateDue keeps an admitted neighbor and clears deferred on a mixed batch', async () => {
    runtime = freshRuntime({ admission: { groups: ['eng'] } })
    runtime.engine.receive(groupTrigger({
      id: 'trg_admitted',
      thread: 'topic/bug-login',
      group: 'eng',
      text: '@ds-agent please fix the login timeout on checkout',
    }))
    seedFiltered()
    seedDeferred(['trg_denied', 'trg_admitted'])

    const decisions = runtime.engine.evaluateDue()
    expect(decisions.map(decision => decision.kind)).toEqual(['accept'])
    expect(decisions[0]!.triggerIds).toEqual(['trg_admitted'])
    const thread = runtime.store.getDoc<Thread>('thread', key)!
    expect(thread.pending).toEqual([])
    expect(thread.deferred).toBe(false)
    const tickets = runtime.store.listDocs<Ticket>('ticket')
    expect(tickets).toHaveLength(1)
    expect(tickets[0]!.originTriggerId).toBe('trg_admitted')
    expect(runtime.log.text()).toContain('Evals.skip-filtered')
    expect(runtime.log.text()).not.toContain('Evals.batch size=2')
    await runtime.finish()
  })
})

describe('subscription bypass rules', () => {
  const follow = followUp()

  it('reject-non-human', () => {
    const live = sampleTicket('ticket_1')
    expect(bypassEligible(live, follow)).toBe(true)
    expect(bypassEligible(live, followUp({ human: false, actor: { source: 'github', id: 'ci-bot' } }))).toBe(false)
  })

  it('reject-direct-chat', () => {
    const live = sampleTicket('ticket_chat', {
      channels: [{ source: 'imessage', thread: 'chat:any;-;+1', address: { handle: '+1' } }],
    })
    expect(bypassEligible(live, follow)).toBe(false)
  })

  it('reject-ended-mandate', () => {
    const live = sampleTicket('ticket_1')
    expect(bypassEligible({
      ...live,
      ended: { at: follow.at, outcome: 'ready', by: 'executor' },
    }, follow)).toBe(false)
    expect(bypassEligible({
      ...live,
      ended: { at: follow.at, outcome: 'stopped', by: 'human' },
    }, follow)).toBe(false)
    expect(bypassEligible({
      ...live,
      mandate: { ...live.mandate, scope: '   ' },
    }, follow)).toBe(false)
  })

  it('arbitration', () => {
    const older = sampleTicket('ticket_old', {
      createdAt: '2026-10-31T00:00:00.000Z',
      assignments: [{ id: 'asg_old', state: 'running', speculative: false, startedAt: '2026-10-31T00:00:01.000Z' }],
    })
    const newerPending = sampleTicket('ticket_new_pending', {
      createdAt: '2026-10-31T00:02:00.000Z',
      assignments: [{ id: 'asg_pending', state: 'pending', speculative: false }],
    })
    const newerRunning = sampleTicket('ticket_new_running', {
      createdAt: '2026-10-31T00:03:00.000Z',
      assignments: [{ id: 'asg_running', state: 'running', speculative: false, startedAt: '2026-10-31T00:03:01.000Z' }],
    })
    const newerEnded = sampleTicket('ticket_new_ended', {
      createdAt: '2026-10-31T00:04:00.000Z',
      assignments: [{
        id: 'asg_ended',
        state: 'ended',
        speculative: false,
        startedAt: '2026-10-31T00:04:01.000Z',
        endedAt: '2026-10-31T00:04:02.000Z',
      }],
    })
    expect(arbitrateSubscribers([older, newerPending])?.id).toBe(older.id)
    expect(arbitrateSubscribers([newerPending, older])?.id).toBe(older.id)
    expect(arbitrateSubscribers([older, newerRunning])?.id).toBe(newerRunning.id)
    expect(arbitrateSubscribers([newerEnded, older])?.id).toBe(older.id)
    expect(arbitrateSubscribers([newerEnded, newerPending])?.id).toBe(newerPending.id)
    expect(arbitrateSubscribers([])).toBeUndefined()
  })

  it('breaks a full tie by natural id order, not lexicographic order', () => {
    const nine = sampleTicket('ticket_9', { createdAt: '2026-10-31T00:00:00.000Z' })
    const ten = sampleTicket('ticket_10', { createdAt: '2026-10-31T00:00:00.000Z' })
    expect(arbitrateSubscribers([nine, ten])?.id).toBe('ticket_10')
    expect(arbitrateSubscribers([ten, nine])?.id).toBe('ticket_10')
  })
})

function sampleTicket(id: string, overrides: Partial<Ticket> = {}): Ticket {
  const createdAt = overrides.createdAt ?? '2026-10-31T00:00:00.000Z'
  return {
    id,
    title: id,
    brief: 'fix the login timeout',
    mandate: {
      strength: 'explicit',
      policyVersion: 'policy-v1',
      scope: 'fix the login timeout',
      actor: { source: 'im', id: 'alex' },
      basis: 'addressed',
    },
    threadKeys: ['im:topic/bug-login'],
    channels: [],
    inputs: [],
    assignments: [{ id: `${id}_asg`, state: 'running', speculative: false, startedAt: createdAt }],
    speculative: false,
    originTriggerId: `trg_${id}`,
    createdAt,
    ...overrides,
  }
}

function followUp(overrides: Partial<Trigger> = {}): Trigger {
  return {
    id: 'trg_follow',
    source: 'im',
    threads: [{ source: 'im', id: 'topic/bug-login' }],
    actor: { source: 'im', id: 'alex' },
    human: true,
    at: '2026-10-31T00:05:00.000Z',
    text: '@ds-agent login still 500, the timeout is back',
    meta: {},
    ...overrides,
  }
}
