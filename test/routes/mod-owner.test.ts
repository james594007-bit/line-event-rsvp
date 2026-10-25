import { env } from 'cloudflare:test'
import { describe, it, expect, beforeEach } from 'vitest'
import { resetTestSchema } from '../setup'
import { makeModeratorWithSession, authedRequest, ORIGIN } from '../helpers'
import app from '../../src/index'
import { signPayload } from '../../src/lib/crypto'

async function call(req: Request) {
  return app.fetch(req, env)
}

describe('requireApproved gate', () => {
  beforeEach(async () => {
    await resetTestSchema(env.DB)
  })

  it('AC-01/02: unauthenticated callers are rejected from moderator APIs', async () => {
    const res = await call(new Request(`${ORIGIN}/api/mod/events`))
    expect(res.status).toBe(401)
  })

  it('AC-02: a pending applicant cannot reach event management APIs', async () => {
    const session = await makeModeratorWithSession(env.DB, { status: 'pending' })
    const res = await call(authedRequest('/api/mod/events', session))
    expect(res.status).toBe(401)
  })

  it('a pending applicant CAN check their own status via /api/mod/me', async () => {
    const session = await makeModeratorWithSession(env.DB, { status: 'pending' })
    const res = await call(authedRequest('/api/mod/me', session))
    expect(res.status).toBe(200)
    const body = await res.json<{ status: string; communityName: string }>()
    expect(body.status).toBe('pending')
    expect(body.communityName).toBe('人生漫旅FB社團Line社群')
  })

  it('a rejected or suspended moderator is also rejected from event management (same as pending)', async () => {
    const rejected = await makeModeratorWithSession(env.DB, { status: 'rejected' })
    const suspended = await makeModeratorWithSession(env.DB, { status: 'suspended' })
    expect((await call(authedRequest('/api/mod/events', rejected))).status).toBe(401)
    expect((await call(authedRequest('/api/mod/events', suspended))).status).toBe(401)
  })

  it('AC-09: suspension takes effect on the very next request with the same cookie', async () => {
    const session = await makeModeratorWithSession(env.DB, { status: 'approved' })
    expect((await call(authedRequest('/api/mod/events', session))).status).toBe(200)

    await env.DB.prepare(`UPDATE moderators SET status = 'suspended', session_version = session_version + 1 WHERE id = ?`).bind(session.moderatorId).run()
    await env.DB.prepare('DELETE FROM sessions WHERE moderator_id = ?').bind(session.moderatorId).run()

    expect((await call(authedRequest('/api/mod/events', session))).status).toBe(401)
  })
})

describe('event CRUD scoped to the authenticated moderator', () => {
  let a: Awaited<ReturnType<typeof makeModeratorWithSession>>
  let b: Awaited<ReturnType<typeof makeModeratorWithSession>>

  beforeEach(async () => {
    await resetTestSchema(env.DB)
    a = await makeModeratorWithSession(env.DB)
    b = await makeModeratorWithSession(env.DB)
  })

  it('creating an event auto-assigns moderator_id to the caller, ignoring any client-supplied owner (AC-07)', async () => {
    const res = await call(
      authedRequest('/api/mod/events', a, {
        method: 'POST',
        body: JSON.stringify({ title: 'Hike', endsAt: '2026-12-01', moderatorId: b.moderatorId, role: 'owner' }),
      })
    )
    expect(res.status).toBe(200)
    const { id } = await res.json<{ id: string }>()
    const row = await env.DB.prepare('SELECT moderator_id FROM events WHERE id = ?').bind(id).first<{ moderator_id: string }>()
    expect(row?.moderator_id).toBe(a.moderatorId) // not b, despite the spoofed field in the body
  })

  it('uses the activity date as the single stored and displayed event date', async () => {
    const res = await call(
      authedRequest('/api/mod/events', a, {
        method: 'POST',
        body: JSON.stringify({
          title: 'One date',
          endsAt: '2026-12-02',
          eventDate: 'legacy display text',
          activityLocation: '青年公園',
        }),
      })
    )
    const { id } = await res.json<{ id: string }>()
    const row = await env.DB.prepare('SELECT event_date, ends_at, activity_location FROM events WHERE id = ?')
      .bind(id)
      .first<{ event_date: string; ends_at: string; activity_location: string }>()
    expect(row).toEqual({ event_date: '2026-12-02', ends_at: '2026-12-02', activity_location: '青年公園' })
  })

  it('rejects event creation without a valid ISO endsAt', async () => {
    const res = await call(authedRequest('/api/mod/events', a, { method: 'POST', body: JSON.stringify({ title: 'No date' }) }))
    expect(res.status).toBe(400)
  })

  it("AC-06: moderator A cannot read moderator B's event — same response as a nonexistent id", async () => {
    const createRes = await call(authedRequest('/api/mod/events', b, { method: 'POST', body: JSON.stringify({ title: "B's event", endsAt: '2026-12-01' }) }))
    const { id } = await createRes.json<{ id: string }>()

    const asA = await call(authedRequest(`/api/mod/events/${id}`, a))
    const nonexistent = await call(authedRequest(`/api/mod/events/does-not-exist`, a))
    expect(asA.status).toBe(nonexistent.status)
    expect(await asA.json()).toEqual(await nonexistent.json())
  })

  it("AC-06: moderator A cannot edit, delete, or view the roster of moderator B's event", async () => {
    const createRes = await call(authedRequest('/api/mod/events', b, { method: 'POST', body: JSON.stringify({ title: "B's event", endsAt: '2026-12-01' }) }))
    const { id } = await createRes.json<{ id: string }>()

    const editRes = await call(authedRequest(`/api/mod/events/${id}`, a, { method: 'PUT', body: JSON.stringify({ title: 'hijacked', endsAt: '2026-12-01' }) }))
    expect(editRes.status).toBe(404)

    const deleteRes = await call(authedRequest(`/api/mod/events/${id}`, a, { method: 'DELETE' }))
    expect(deleteRes.status).toBe(404)

    const rosterRes = await call(authedRequest(`/api/mod/events/${id}/roster`, a))
    expect(rosterRes.status).toBe(404)

    // and B's event is untouched
    const stillThere = await env.DB.prepare('SELECT title FROM events WHERE id = ?').bind(id).first<{ title: string }>()
    expect(stillThere?.title).toBe("B's event")
  })

  it('GET /api/mod/events only lists the caller own events', async () => {
    await call(authedRequest('/api/mod/events', a, { method: 'POST', body: JSON.stringify({ title: "A1", endsAt: '2026-12-01' }) }))
    await call(authedRequest('/api/mod/events', a, { method: 'POST', body: JSON.stringify({ title: "A2", endsAt: '2026-12-01' }) }))
    await call(authedRequest('/api/mod/events', b, { method: 'POST', body: JSON.stringify({ title: "B1", endsAt: '2026-12-01' }) }))

    const res = await call(authedRequest('/api/mod/events', a))
    const list = await res.json<{ title: string }[]>()
    expect(list.map((e) => e.title).sort()).toEqual(['A1', 'A2'])
  })
})

describe('CSRF and same-origin enforcement', () => {
  let session: Awaited<ReturnType<typeof makeModeratorWithSession>>

  beforeEach(async () => {
    await resetTestSchema(env.DB)
    session = await makeModeratorWithSession(env.DB)
  })

  it('rejects a mutating request with no CSRF header at all', async () => {
    const req = new Request(`${ORIGIN}/api/mod/events`, {
      method: 'POST',
      headers: { Cookie: session.cookieHeader, 'Content-Type': 'application/json', Origin: ORIGIN },
      body: JSON.stringify({ title: 'x', endsAt: '2026-12-01' }),
    })
    expect((await call(req)).status).toBe(403)
  })

  it('rejects a mutating request whose CSRF header does not match the cookie', async () => {
    const req = new Request(`${ORIGIN}/api/mod/events`, {
      method: 'POST',
      headers: { Cookie: session.cookieHeader, 'Content-Type': 'application/json', Origin: ORIGIN, 'X-CSRF-Token': 'wrong-token' },
      body: JSON.stringify({ title: 'x', endsAt: '2026-12-01' }),
    })
    expect((await call(req)).status).toBe(403)
  })

  it('rejects a mutating request from a mismatched Origin even with a correct CSRF token', async () => {
    const req = new Request(`${ORIGIN}/api/mod/events`, {
      method: 'POST',
      headers: {
        Cookie: session.cookieHeader,
        'Content-Type': 'application/json',
        Origin: 'https://evil.example',
        'X-CSRF-Token': session.csrfToken,
      },
      body: JSON.stringify({ title: 'x', endsAt: '2026-12-01' }),
    })
    expect((await call(req)).status).toBe(403)
  })

  it('accepts a mutating request with matching CSRF token and same-origin', async () => {
    const res = await call(authedRequest('/api/mod/events', session, { method: 'POST', body: JSON.stringify({ title: 'ok', endsAt: '2026-12-01' }) }))
    expect(res.status).toBe(200)
  })
})

describe('owner-only routes', () => {
  beforeEach(async () => {
    await resetTestSchema(env.DB)
  })

  it('AC-05: an approved moderator who is not the owner cannot approve/reject/suspend/restore', async () => {
    const owner = await makeModeratorWithSession(env.DB, { role: 'owner' })
    const applicant = await makeModeratorWithSession(env.DB, { status: 'pending' })
    const nonOwnerModerator = await makeModeratorWithSession(env.DB)

    const res = await call(authedRequest(`/api/owner/moderators/${applicant.moderatorId}/approve`, nonOwnerModerator, { method: 'POST' }))
    expect(res.status).toBe(403)
    const stillPending = await env.DB.prepare('SELECT status FROM moderators WHERE id = ?').bind(applicant.moderatorId).first<{ status: string }>()
    expect(stillPending?.status).toBe('pending')
    void owner
  })

  it('AC-04: the owner can approve a pending applicant, who then passes requireApproved on their *existing* session', async () => {
    const owner = await makeModeratorWithSession(env.DB, { role: 'owner' })
    const applicant = await makeModeratorWithSession(env.DB, { status: 'pending' })

    const approveRes = await call(authedRequest(`/api/owner/moderators/${applicant.moderatorId}/approve`, owner, { method: 'POST' }))
    expect(approveRes.status).toBe(200)

    // same cookie as before approval — proves status is rechecked fresh, not cached at login
    const res = await call(authedRequest('/api/mod/events', applicant))
    expect(res.status).toBe(200)
  })

  it('suspend immediately blocks event management on the moderator existing session', async () => {
    const owner = await makeModeratorWithSession(env.DB, { role: 'owner' })
    const moderator = await makeModeratorWithSession(env.DB, { status: 'approved' })
    expect((await call(authedRequest('/api/mod/events', moderator))).status).toBe(200)

    const suspendRes = await call(authedRequest(`/api/owner/moderators/${moderator.moderatorId}/suspend`, owner, { method: 'POST', body: JSON.stringify({ reason: 'test' }) }))
    expect(suspendRes.status).toBe(200)

    expect((await call(authedRequest('/api/mod/events', moderator))).status).toBe(401)
  })

  it('does not reveal suspend_reason in the list endpoint, only the single-record lookup', async () => {
    const owner = await makeModeratorWithSession(env.DB, { role: 'owner' })
    const moderator = await makeModeratorWithSession(env.DB, { status: 'approved' })
    await call(authedRequest(`/api/owner/moderators/${moderator.moderatorId}/suspend`, owner, { method: 'POST', body: JSON.stringify({ reason: 'secret reason' }) }))

    const listRes = await call(authedRequest('/api/owner/moderators', owner))
    const list = await listRes.json<Record<string, unknown>[]>()
    expect(list.every((row) => !('suspend_reason' in row))).toBe(true)

    const singleRes = await call(authedRequest(`/api/owner/moderators/${moderator.moderatorId}`, owner))
    const single = await singleRes.json<{ suspend_reason: string }>()
    expect(single.suspend_reason).toBe('secret reason')
  })
})

describe('public event endpoint never leaks moderator_id or ends_at', () => {
  it('through the live route (not just the unit-tested mapper)', async () => {
    await resetTestSchema(env.DB)
    const session = await makeModeratorWithSession(env.DB)
    const createRes = await call(authedRequest('/api/mod/events', session, { method: 'POST', body: JSON.stringify({ title: 'Public test', endsAt: '2026-12-01' }) }))
    const { id } = await createRes.json<{ id: string }>()

    const publicRes = await call(new Request(`${ORIGIN}/api/events/${id}`))
    expect(publicRes.status).toBe(200)
    const body = await publicRes.json<Record<string, unknown>>()
    expect(body).not.toHaveProperty('moderator_id')
    expect(body).not.toHaveProperty('ends_at')
    expect(body.title).toBe('Public test')
  })
})

describe('participant registration identity', () => {
  beforeEach(async () => {
    await resetTestSchema(env.DB)
  })

  it('requires a LINE-verified participant cookie and ignores spoofed identity fields', async () => {
    const moderator = await makeModeratorWithSession(env.DB)
    const createRes = await call(
      authedRequest('/api/mod/events', moderator, { method: 'POST', body: JSON.stringify({ title: 'Secure signup', endsAt: '2026-12-01' }) })
    )
    const { id } = await createRes.json<{ id: string }>()

    const unauthenticated = await call(
      new Request(`${ORIGIN}/api/events/${id}/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
        body: JSON.stringify({ lineUserId: 'U_forged' }),
      })
    )
    expect(unauthenticated.status).toBe(401)

    const participant = await signPayload(env.COOKIE_SIGNING_SECRET, { lineUserId: 'U_verified', displayName: 'Verified' }, 600)
    const authenticated = await call(
      new Request(`${ORIGIN}/api/events/${id}/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: ORIGIN, Cookie: `participant_identity=${participant}` },
        body: JSON.stringify({ lineUserId: 'U_forged', displayName: 'Forged' }),
      })
    )
    expect(authenticated.status).toBe(200)

    const row = await env.DB.prepare('SELECT line_user_id, display_name FROM registrations WHERE event_id = ?').bind(id).first<any>()
    expect(row).toEqual({ line_user_id: 'U_verified', display_name: 'Verified' })
  })

  it('lets a participant update their own registration until cutoff, then becomes read-only', async () => {
    const moderator = await makeModeratorWithSession(env.DB)
    const createRes = await call(
      authedRequest('/api/mod/events', moderator, {
        method: 'POST',
        body: JSON.stringify({
          title: 'Editable signup',
          endsAt: '2099-12-02',
          cutoffAt: '2099-12-01T23:59',
          enableCarRole: true,
          enablePlusOne: true,
        }),
      })
    )
    const { id } = await createRes.json<{ id: string }>()
    const participant = await signPayload(env.COOKIE_SIGNING_SECRET, { lineUserId: 'U_editor', displayName: 'Editor' }, 600)
    const headers = { 'Content-Type': 'application/json', Origin: ORIGIN, Cookie: `participant_identity=${participant}` }

    expect((await call(new Request(`${ORIGIN}/api/events/${id}/register`, { method: 'POST', headers, body: JSON.stringify({ role: 'driver', plusOneCount: 0 }) }))).status).toBe(200)
    expect((await call(new Request(`${ORIGIN}/api/events/${id}/register`, { method: 'POST', headers, body: JSON.stringify({ role: 'passenger', plusOneCount: 2 }) }))).status).toBe(200)

    const mine = await call(new Request(`${ORIGIN}/api/events/${id}/my-registration`, { headers: { Cookie: `participant_identity=${participant}` } }))
    expect(await mine.json()).toEqual({ status: 'registered', role: 'passenger', attendanceType: null, plusOneCount: 2 })

    await env.DB.prepare(`UPDATE events SET cutoff_at = '2000-01-01T00:00' WHERE id = ?`).bind(id).run()
    const publicEvent = await call(new Request(`${ORIGIN}/api/events/${id}`))
    expect((await publicEvent.json<any>()).registration_closed).toBe(true)
    expect((await call(new Request(`${ORIGIN}/api/events/${id}/register`, { method: 'POST', headers, body: JSON.stringify({ plusOneCount: 0 }) }))).status).toBe(409)
    expect((await call(new Request(`${ORIGIN}/api/events/${id}/cancel`, { method: 'POST', headers, body: '{}' }))).status).toBe(409)
  })

  it('allows the owning moderator to edit, remove, and restore a participant with an audit trail', async () => {
    const moderator = await makeModeratorWithSession(env.DB)
    const createRes = await call(
      authedRequest('/api/mod/events', moderator, { method: 'POST', body: JSON.stringify({ title: 'Managed signup', endsAt: '2099-12-01', capacity: 5 }) })
    )
    const { id } = await createRes.json<{ id: string }>()
    await env.DB.prepare(
      `INSERT INTO registrations (event_id, line_user_id, display_name, plus_one_count, status)
       VALUES (?, 'U_managed', 'Managed', 0, 'registered')`
    ).bind(id).run()

    const edit = await call(
      authedRequest(`/api/mod/events/${id}/registrations/U_managed`, moderator, {
        method: 'PUT',
        body: JSON.stringify({ role: 'driver', attendanceType: 'activity_only', plusOneCount: 1 }),
      })
    )
    expect(edit.status).toBe(200)
    expect((await call(authedRequest(`/api/mod/events/${id}/registrations/U_managed`, moderator, { method: 'DELETE' }))).status).toBe(200)
    expect((await call(authedRequest(`/api/mod/events/${id}/registrations/U_managed/restore`, moderator, { method: 'POST', body: '{}' }))).status).toBe(200)

    const registration = await env.DB.prepare(
      `SELECT status, role, attendance_type, plus_one_count, cancelled_by FROM registrations WHERE event_id = ? AND line_user_id = 'U_managed'`
    ).bind(id).first<any>()
    expect(registration).toEqual({ status: 'registered', role: 'driver', attendance_type: 'activity_only', plus_one_count: 1, cancelled_by: null })
    const audit = await env.DB.prepare(`SELECT action FROM registration_audit_log WHERE event_id = ? ORDER BY id`).bind(id).all<any>()
    expect(audit.results.map((row) => row.action)).toEqual(['edit', 'remove', 'restore'])
  })
})
