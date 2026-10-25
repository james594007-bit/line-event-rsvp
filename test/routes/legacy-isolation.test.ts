import { env } from 'cloudflare:test'
import { describe, it, expect, beforeEach } from 'vitest'
import { resetTestSchema } from '../setup'
import { makeModeratorWithSession, authedRequest, ORIGIN } from '../helpers'
import app from '../../src/index'

async function call(req: Request) {
  return app.fetch(req, env)
}

function legacyRequest(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers)
  headers.set('X-Admin-Passcode', env.ADMIN_PASSCODE)
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
  return new Request(`${ORIGIN}${path}`, { ...init, headers })
}

describe('legacy passcode system cannot cross into moderator-owned events', () => {
  let moderator: Awaited<ReturnType<typeof makeModeratorWithSession>>
  let moderatorEventId: string

  beforeEach(async () => {
    await resetTestSchema(env.DB)
    moderator = await makeModeratorWithSession(env.DB)
    const res = await call(
      authedRequest('/api/mod/events', moderator, { method: 'POST', body: JSON.stringify({ title: "Moderator's event", endsAt: '2026-12-01' }) })
    )
    moderatorEventId = (await res.json<{ id: string }>()).id
  })

  it('created legacy events are owned by the fixed LEGACY_MODERATOR_ID', async () => {
    const createRes = await call(legacyRequest('/api/events', { method: 'POST', body: JSON.stringify({ title: 'Legacy event', endsAt: '2026-12-01' }) }))
    const { id } = await createRes.json<{ id: string }>()
    const row = await env.DB.prepare('SELECT moderator_id FROM events WHERE id = ?').bind(id).first<{ moderator_id: string }>()
    expect(row?.moderator_id).toBe('mod_legacy_admin')
  })

  it("the legacy list endpoint does not include a moderator's events", async () => {
    const res = await call(legacyRequest('/api/events'))
    const list = await res.json<{ id: string }[]>()
    expect(list.some((e) => e.id === moderatorEventId)).toBe(false)
  })

  it("the legacy passcode cannot edit a moderator's event (404, and the event is untouched)", async () => {
    const res = await call(
      legacyRequest(`/api/events/${moderatorEventId}`, { method: 'PUT', body: JSON.stringify({ title: 'HIJACKED', endsAt: '2026-12-01' }) })
    )
    expect(res.status).toBe(404)
    const row = await env.DB.prepare('SELECT title FROM events WHERE id = ?').bind(moderatorEventId).first<{ title: string }>()
    expect(row?.title).toBe("Moderator's event")
  })

  it("the legacy passcode cannot delete a moderator's event, and does not touch its registrations either", async () => {
    // register someone for the moderator's event via the public participant endpoint
    const regRes = await call(
      new Request(`${ORIGIN}/api/events/${moderatorEventId}/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lineUserId: 'U_participant', displayName: 'Someone' }),
      })
    )
    expect(regRes.status).toBe(200)

    const deleteRes = await call(legacyRequest(`/api/events/${moderatorEventId}`, { method: 'DELETE' }))
    expect(deleteRes.status).toBe(404)

    const eventStillThere = await env.DB.prepare('SELECT id FROM events WHERE id = ?').bind(moderatorEventId).first()
    expect(eventStillThere).not.toBeNull()
    const registrationStillThere = await env.DB
      .prepare("SELECT COUNT(*) as n FROM registrations WHERE event_id = ? AND status = 'registered'")
      .bind(moderatorEventId)
      .first<{ n: number }>()
    expect(registrationStillThere?.n).toBe(1) // not silently wiped by the unscoped-looking delete
  })

  it('the legacy passcode CAN edit and delete its own (LEGACY_MODERATOR_ID-owned) event', async () => {
    const createRes = await call(legacyRequest('/api/events', { method: 'POST', body: JSON.stringify({ title: 'Legacy own', endsAt: '2026-12-01' }) }))
    const { id } = await createRes.json<{ id: string }>()

    const editRes = await call(legacyRequest(`/api/events/${id}`, { method: 'PUT', body: JSON.stringify({ title: 'Legacy edited', endsAt: '2026-12-01' }) }))
    expect(editRes.status).toBe(200)

    const deleteRes = await call(legacyRequest(`/api/events/${id}`, { method: 'DELETE' }))
    expect(deleteRes.status).toBe(200)
    expect(await env.DB.prepare('SELECT id FROM events WHERE id = ?').bind(id).first()).toBeNull()
  })
})
