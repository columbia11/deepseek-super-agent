import { describe, expect, it } from 'vitest'
import { HttpGoogleWorkspaceApi, type GoogleFetchQuery } from '../src/connectors/google.ts'
import { RefreshTokenProvider, type FetchLike, type GoogleTokenProvider } from '../src/connectors/oauth.ts'
import type { GoogleCredentials } from '../src/connectors/config.ts'

const T0 = Date.parse('2026-11-05T10:00:00.000Z')
const credentials: GoogleCredentials = {
  clientId: 'client-id',
  clientSecret: 'client-secret',
  refreshToken: 'refresh-token',
}

function query(overrides: Partial<GoogleFetchQuery> = {}): GoogleFetchQuery {
  return {
    since: new Date(T0 - 60 * 60_000).toISOString(),
    until: new Date(T0).toISOString(),
    limit: 10,
    lookaheadMinutes: 120,
    ...overrides,
  }
}

const fixedToken: GoogleTokenProvider = {
  accessToken: async () => 'access-token',
  invalidate: () => undefined,
}

describe('Google OAuth token provider', () => {
  it('exchanges the refresh token once, caches the access token, and refreshes after expiry', async () => {
    let now = T0
    const calls: { url: string; init?: RequestInit }[] = []
    const fetchImpl: FetchLike = async (input, init) => {
      calls.push({ url: String(input), init })
      return new Response(JSON.stringify({ access_token: 'token-1', expires_in: 3_600 }), { status: 200 })
    }
    const provider = new RefreshTokenProvider(credentials, { fetch: fetchImpl, now: () => now })
    expect(await provider.accessToken()).toBe('token-1')
    expect(await provider.accessToken()).toBe('token-1')
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toContain('oauth2.googleapis.com/token')
    const body = String(calls[0]?.init?.body)
    expect(body).toContain('grant_type=refresh_token')
    expect(body).toContain('client_id=client-id')

    now += 3_600_000
    expect(await provider.accessToken()).toBe('token-1')
    expect(calls).toHaveLength(2)
  })

  it('reports a bounded error reason without leaking credentials', async () => {
    const fetchImpl: FetchLike = async () => new Response(
      JSON.stringify({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }),
      { status: 400 },
    )
    const provider = new RefreshTokenProvider(credentials, { fetch: fetchImpl, now: () => T0 })
    await expect(provider.accessToken()).rejects.toThrow(/status=400 reason=invalid_grant/)
    const message = await provider.accessToken().catch(error => String(error))
    expect(message).not.toContain('refresh-token')
    expect(message).not.toContain('client-secret')
  })

  it('fails closed when the token response has no access token', async () => {
    const fetchImpl: FetchLike = async () => new Response(JSON.stringify({ expires_in: 3_600 }), { status: 200 })
    const provider = new RefreshTokenProvider(credentials, { fetch: fetchImpl, now: () => T0 })
    await expect(provider.accessToken()).rejects.toThrow(/no access_token/)
  })
})

describe('Google Workspace mapping', () => {
  it('maps Gmail messages and marks unread important mail', async () => {
    const seen: string[] = []
    const fetchImpl: FetchLike = async input => {
      const url = String(input)
      seen.push(url)
      if (url.includes('/messages/m1')) {
        return new Response(JSON.stringify({
          id: 'm1',
          threadId: 't1',
          labelIds: ['UNREAD', 'IMPORTANT'],
          snippet: 'The invoice is attached',
          internalDate: String(T0),
          payload: {
            headers: [
              { name: 'Subject', value: 'Invoice for November' },
              { name: 'From', value: 'Billing <billing@example.com>' },
              { name: 'To', value: 'owner@example.com' },
            ],
          },
        }), { status: 200 })
      }
      return new Response(JSON.stringify({ messages: [{ id: 'm1' }] }), { status: 200 })
    }
    const api = new HttpGoogleWorkspaceApi(fixedToken, {
      fetch: fetchImpl,
      now: () => T0,
      apiBase: 'https://example.test',
    })
    const [record] = await api.fetch('gmail', query())
    expect(record).toMatchObject({
      service: 'gmail',
      kind: 'message',
      externalId: 'm1',
      title: 'Invoice for November',
      wake: true,
      wakeReason: 'unread important mail',
    })
    expect(record?.participants).toEqual(['billing@example.com', 'owner@example.com'])
    expect(seen.some(url => url.includes('/gmail/v1/users/me/messages?q=after'))).toBe(true)
    expect(seen.some(url => url.includes('format=metadata'))).toBe(true)
  })

  it('maps an imminent calendar event and leaves a distant event without a wake', async () => {
    const fetchImpl: FetchLike = async () => new Response(JSON.stringify({
      items: [
        {
          id: 'e1',
          summary: 'Design review',
          description: 'Review the connector index',
          location: 'Room 4',
          status: 'confirmed',
          updated: new Date(T0 - 60_000).toISOString(),
          start: { dateTime: new Date(T0 + 30 * 60_000).toISOString() },
          end: { dateTime: new Date(T0 + 60 * 60_000).toISOString() },
          organizer: { email: 'owner@example.com' },
          attendees: [{ email: 'guest@example.com' }],
          htmlLink: 'https://calendar.example/e1',
        },
        {
          id: 'e2',
          summary: 'Next quarter planning',
          status: 'confirmed',
          start: { dateTime: new Date(T0 + 10 * 86_400_000).toISOString() },
          end: { dateTime: new Date(T0 + 10 * 86_400_000 + 60 * 60_000).toISOString() },
        },
      ],
    }), { status: 200 })
    const api = new HttpGoogleWorkspaceApi(fixedToken, {
      fetch: fetchImpl,
      now: () => T0,
      apiBase: 'https://example.test',
    })
    const records = await api.fetch('calendar', query())
    expect(records[0]).toMatchObject({
      service: 'calendar',
      kind: 'event',
      externalId: 'e1',
      title: 'Design review',
      wake: true,
      wakeReason: 'calendar event starting soon',
    })
    expect(records[0]?.participants).toEqual(['owner@example.com', 'guest@example.com'])
    expect(records[1]?.wake).toBe(false)
  })

  it('maps Docs, Sheets, Slides, and Drive through the Drive endpoint', async () => {
    const seen: string[] = []
    const fetchImpl: FetchLike = async input => {
      seen.push(String(input))
      return new Response(JSON.stringify({
        files: [{
          id: 'doc-1',
          name: 'Shared roadmap',
          description: 'Connector notes',
          mimeType: 'application/vnd.google-apps.document',
          modifiedTime: new Date(T0 - 10 * 60_000).toISOString(),
          webViewLink: 'https://docs.example/doc-1',
          shared: true,
          owners: [{ emailAddress: 'owner@example.com' }],
          lastModifyingUser: { emailAddress: 'guest@example.com' },
        }],
      }), { status: 200 })
    }
    const api = new HttpGoogleWorkspaceApi(fixedToken, {
      fetch: fetchImpl,
      now: () => T0,
      apiBase: 'https://example.test',
    })
    const [doc] = await api.fetch('docs', query())
    expect(doc).toMatchObject({
      service: 'docs',
      kind: 'document',
      externalId: 'doc-1',
      title: 'Shared roadmap',
      wake: true,
      wakeReason: 'shared document changed by another person',
    })
    expect(seen[0]).toContain('mimeType')
    await api.fetch('sheets', query())
    await api.fetch('slides', query())
    await api.fetch('drive', query())
    expect(seen).toHaveLength(4)
  })

  it('maps a task due inside the lookahead window', async () => {
    const fetchImpl: FetchLike = async () => new Response(JSON.stringify({
      items: [{
        id: 'task-1',
        title: 'Send the contract',
        notes: 'Use the signed copy',
        due: new Date(T0 + 45 * 60_000).toISOString(),
        status: 'needsAction',
        updated: new Date(T0 - 60_000).toISOString(),
      }],
    }), { status: 200 })
    const api = new HttpGoogleWorkspaceApi(fixedToken, {
      fetch: fetchImpl,
      now: () => T0,
      apiBase: 'https://example.test',
    })
    const [task] = await api.fetch('tasks', query())
    expect(task).toMatchObject({
      service: 'tasks',
      kind: 'task',
      externalId: 'task-1',
      title: 'Send the contract',
      wake: true,
      wakeReason: 'task due soon',
    })
  })
})

/** Drive v3 only returns `lastModifyingUser.me` when the `fields` mask asks for it. */
function fakeDriveFetch(files: Record<string, unknown>[]): FetchLike {
  return async input => {
    const fields = new URL(String(input)).searchParams.get('fields') ?? ''
    const wantsMe = /lastModifyingUser\([^)]*\bme\b/.test(fields)
    return new Response(JSON.stringify({
      files: files.map(file => {
        const { me, ...editor } = file.lastModifyingUser as Record<string, unknown>
        return { ...file, lastModifyingUser: wantsMe ? { ...editor, me } : editor }
      }),
    }), { status: 200 })
  }
}

/** Tasks v1 filters `updatedMin` / `dueMin` / `dueMax` server-side; `due` is a date at 00:00:00Z. */
function fakeTasksFetch(items: Record<string, unknown>[], seen: URL[] = []): FetchLike {
  return async input => {
    const url = new URL(String(input))
    seen.push(url)
    const bound = (key: string) => {
      const value = url.searchParams.get(key)
      return value === null ? undefined : Date.parse(value)
    }
    const updatedMin = bound('updatedMin')
    const dueMin = bound('dueMin')
    const dueMax = bound('dueMax')
    const out = items.filter(item => {
      const updated = Date.parse(String(item.updated))
      const due = typeof item.due === 'string' ? Date.parse(item.due) : Number.NaN
      if (updatedMin !== undefined && !(updated >= updatedMin)) return false
      if (dueMin !== undefined && !(due >= dueMin)) return false
      if (dueMax !== undefined && !(due <= dueMax)) return false
      return true
    })
    return new Response(JSON.stringify({ items: out }), { status: 200 })
  }
}

describe('review fixes (PR #174)', () => {
  it('judges "changed by another person" by the requesting user, not the file owner', async () => {
    const shared = {
      mimeType: 'application/vnd.google-apps.document',
      modifiedTime: new Date(T0 - 10 * 60_000).toISOString(),
      shared: true,
    }
    const api = new HttpGoogleWorkspaceApi(fixedToken, {
      fetch: fakeDriveFetch([
        // Bob's doc, last edited by the connected user: not someone else's change.
        {
          ...shared,
          id: 'doc-bob-edited-by-me',
          name: 'Q4 plan',
          owners: [{ emailAddress: 'bob@corp.example' }],
          lastModifyingUser: { emailAddress: 'me@corp.example', me: true },
        },
        // Shared-drive item: Drive returns no `owners`; Carol changed it.
        {
          ...shared,
          id: 'doc-shared-drive',
          name: 'Team handbook',
          lastModifyingUser: { emailAddress: 'carol@corp.example', me: false },
        },
        // The connected user's own doc, changed by Bob: still wakes.
        {
          ...shared,
          id: 'doc-mine-edited-by-bob',
          name: 'My notes',
          owners: [{ emailAddress: 'me@corp.example' }],
          lastModifyingUser: { emailAddress: 'bob@corp.example', me: false },
        },
      ]),
      now: () => T0,
      apiBase: 'https://example.test',
    })
    const docs = await api.fetch('docs', query())
    const wake = Object.fromEntries(docs.map(doc => [doc.externalId, doc.wake]))
    expect(wake).toEqual({
      'doc-bob-edited-by-me': false,
      'doc-shared-drive': true,
      'doc-mine-edited-by-bob': true,
    })
  })

  it('wakes for an open task due today even when it was created before the poll cursor', async () => {
    const seen: URL[] = []
    const api = new HttpGoogleWorkspaceApi(fixedToken, {
      fetch: fakeTasksFetch([
        { id: 't-today', title: 'Pay rent', due: '2026-11-05T00:00:00.000Z', status: 'needsAction', updated: '2026-11-01T09:00:00.000Z' },
        { id: 't-tomorrow', title: 'Book flights', due: '2026-11-06T00:00:00.000Z', status: 'needsAction', updated: '2026-11-01T09:00:00.000Z' },
        { id: 't-yesterday', title: 'Old errand', due: '2026-11-04T00:00:00.000Z', status: 'needsAction', updated: '2026-11-01T09:00:00.000Z' },
        { id: 't-edited', title: 'Undated idea', status: 'needsAction', updated: new Date(T0 - 5 * 60_000).toISOString() },
      ], seen),
      now: () => T0,
      apiBase: 'https://example.test',
    })
    // T0 is 18:00 in Asia/Shanghai; the cursor only looks back 20 minutes.
    const tasks = await api.fetch('tasks', query({
      since: new Date(T0 - 20 * 60_000).toISOString(),
      timezone: 'Asia/Shanghai',
    }))
    const wake = Object.fromEntries(tasks.map(task => [task.externalId, task.wake]))
    expect(wake['t-today']).toBe(true)
    expect(wake['t-tomorrow']).not.toBe(true)
    expect(wake['t-yesterday']).not.toBe(true)
    // Recently changed tasks are still indexed.
    expect(wake['t-edited']).toBe(false)
    expect(tasks.find(task => task.externalId === 't-today')?.wakeReason).toBe('task due soon')
  })
})
