import { Hono } from 'hono'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'
import type { Bindings } from '../bindings'
import { requireAuthenticated, requireApproved, requireCsrf, requireSameOrigin, CSRF_COOKIE_NAME } from '../middleware'
import { applyAsModerator } from '../lib/moderators'
import { createSession, SESSION_COOKIE_NAME } from '../lib/session'
import { checkRateLimit } from '../lib/ratelimit'
import { verifyPayload, randomToken } from '../lib/crypto'
import { getOwnedEvent, isValidIsoDate } from '../lib/event-ownership'
import { VERIFIED_IDENTITY_COOKIE } from './auth'
import { COMMUNITY_NAME } from '../lib/branding'
import { isValidTaipeiCutoff } from '../lib/registration-window'

export const modRoutes = new Hono<{ Bindings: Bindings }>()

function randomId(prefix: string) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 10)}`
}

const VALID_ROLES = new Set(['driver', 'passenger'])
const VALID_ATTENDANCE_TYPES = new Set(['activity_only', 'activity_and_meal', 'meal_only'])

async function registrationFitsCapacity(db: D1Database, eventId: string, lineUserId: string, plusOneCount: number, capacity: number | null) {
  if (!capacity) return true
  const others = await db.prepare(
    `SELECT COALESCE(SUM(1 + plus_one_count), 0) AS n
     FROM registrations WHERE event_id = ? AND status = 'registered' AND line_user_id != ?`
  )
    .bind(eventId, lineUserId)
    .first<{ n: number }>()
  return (others?.n ?? 0) + 1 + plusOneCount <= capacity
}

async function auditRegistrationAction(
  db: D1Database,
  eventId: string,
  lineUserId: string,
  actorModeratorId: string,
  action: 'edit' | 'remove' | 'restore'
) {
  await db.prepare(
    `INSERT INTO registration_audit_log (event_id, line_user_id, actor_moderator_id, action)
     VALUES (?, ?, ?, ?)`
  )
    .bind(eventId, lineUserId, actorModeratorId, action)
    .run()
}

// ---- community name is fixed, server-side, never editable ----
export const FIXED_COMMUNITY_NAME = COMMUNITY_NAME

// ---- apply (bridges the verified-but-not-yet-applicant identity cookie into a real application) ----
modRoutes.post('/api/mod/apply', requireSameOrigin, async (c) => {
  const bridge = await verifyPayload<{ lineUserId: string; displayName?: string }>(c.env.COOKIE_SIGNING_SECRET, getCookie(c, VERIFIED_IDENTITY_COOKIE))
  if (!bridge) return c.json({ error: 'not_verified' }, 401)

  const rl = await checkRateLimit(c.env.DB, `apply:${bridge.lineUserId}`, 5, 3600)
  if (!rl.allowed) return c.json({ error: 'rate_limited' }, 429)

  const result = await applyAsModerator(c.env.DB, bridge.lineUserId, bridge.displayName)
  deleteCookie(c, VERIFIED_IDENTITY_COOKIE, { path: '/' })

  // Issue a real session now regardless of outcome (created/already_pending/
  // reapplied/already_active) so the next page load can show status via
  // GET /api/mod/me instead of needing another LINE login round trip.
  const modRow = await c.env.DB.prepare('SELECT session_version FROM moderators WHERE id = ?').bind(result.moderatorId).first<{ session_version: number }>()
  const { token, expiresAt } = await createSession(c.env.DB, result.moderatorId, modRow?.session_version ?? 0)
  setCookie(c, SESSION_COOKIE_NAME, token, { httpOnly: true, secure: true, sameSite: 'Lax', path: '/', expires: new Date(expiresAt) })
  setCookie(c, CSRF_COOKIE_NAME, randomToken(16), { httpOnly: false, secure: true, sameSite: 'Lax', path: '/', expires: new Date(expiresAt) })

  return c.json({ outcome: result.outcome, communityName: FIXED_COMMUNITY_NAME })
})

// ---- who am I / what's my status ----
modRoutes.get('/api/mod/me', requireAuthenticated, async (c) => {
  const moderator = c.get('moderator')
  return c.json({
    role: moderator.role,
    status: moderator.status,
    communityName: FIXED_COMMUNITY_NAME,
  })
})

// ---- event management, scoped to the logged-in moderator's own events ----

modRoutes.get('/api/mod/events', requireAuthenticated, requireApproved, async (c) => {
  const moderator = c.get('moderator')
  const rows = await c.env.DB.prepare(
    `SELECT e.id, e.title, e.event_date, e.ends_at, e.capacity, e.cutoff_at, e.status, e.created_at,
       COUNT(CASE WHEN r.status = 'registered' THEN 1 END) as registered_count,
       COALESCE(SUM(CASE WHEN r.status = 'registered' THEN 1 + r.plus_one_count END), 0) as total_headcount
     FROM events e
     LEFT JOIN registrations r ON r.event_id = e.id
     WHERE e.moderator_id = ?
     GROUP BY e.id
     ORDER BY e.created_at DESC`
  )
    .bind(moderator.id)
    .all()
  return c.json(rows.results)
})

interface EventBody {
  title?: string
  organizer?: string
  endsAt?: string
  activityLocation?: string
  meetingLocation?: string
  meetingTime?: string
  fee?: string
  passengerFee?: string
  capacity?: number
  cutoffAt?: string
  groupLink?: string
  notes?: string
  status?: 'open' | 'full' | 'closed'
  enableAttendanceType?: boolean
  enableCarRole?: boolean
  enablePlusOne?: boolean
}

modRoutes.post('/api/mod/events', requireAuthenticated, requireApproved, requireCsrf, requireSameOrigin, async (c) => {
  const moderator = c.get('moderator')
  const body = await c.req.json<EventBody>()
  if (!body.title) return c.json({ error: 'title required' }, 400)
  if (!isValidIsoDate(body.endsAt)) return c.json({ error: 'endsAt must be an ISO date (YYYY-MM-DD)' }, 400)
  if (body.cutoffAt && !isValidTaipeiCutoff(body.cutoffAt)) return c.json({ error: 'cutoffAt must be YYYY-MM-DDTHH:mm' }, 400)

  const id = randomId('ev')
  await c.env.DB.prepare(
    `INSERT INTO events
      (id, moderator_id, title, organizer, event_date, ends_at, activity_location, meeting_location, meeting_time, fee, passenger_fee,
       capacity, cutoff_at, group_link, notes, enable_attendance_type, enable_car_role, enable_plus_one)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      id,
      moderator.id, // moderator_id is always the authenticated caller — never client-supplied (AC-07)
      body.title,
      body.organizer ?? null,
      body.endsAt,
      body.endsAt,
      body.activityLocation ?? null,
      body.meetingLocation ?? null,
      body.meetingTime ?? null,
      body.fee ?? null,
      body.passengerFee ?? null,
      body.capacity ?? null,
      body.cutoffAt ?? null,
      body.groupLink ?? null,
      body.notes ?? null,
      body.enableAttendanceType ? 1 : 0,
      body.enableCarRole ? 1 : 0,
      body.enablePlusOne ? 1 : 0
    )
    .run()
  return c.json({ id })
})

modRoutes.get('/api/mod/events/:id', requireAuthenticated, requireApproved, async (c) => {
  const moderator = c.get('moderator')
  const event = await getOwnedEvent(c.env.DB, moderator.id, c.req.param('id')!)
  if (!event) return c.json({ error: 'not_found' }, 404) // same response whether it doesn't exist or isn't yours (AC-06)
  return c.json(event)
})

modRoutes.put('/api/mod/events/:id', requireAuthenticated, requireApproved, requireCsrf, requireSameOrigin, async (c) => {
  const moderator = c.get('moderator')
  const id = c.req.param('id')!
  const existing = await getOwnedEvent(c.env.DB, moderator.id, id)
  if (!existing) return c.json({ error: 'not_found' }, 404)

  const body = await c.req.json<EventBody>()
  if (!body.title) return c.json({ error: 'title required' }, 400)
  if (!isValidIsoDate(body.endsAt)) return c.json({ error: 'endsAt must be an ISO date (YYYY-MM-DD)' }, 400)
  if (body.cutoffAt && !isValidTaipeiCutoff(body.cutoffAt)) return c.json({ error: 'cutoffAt must be YYYY-MM-DDTHH:mm' }, 400)

  await c.env.DB.prepare(
    `UPDATE events SET
      title = ?, organizer = ?, event_date = ?, ends_at = ?, activity_location = ?, meeting_location = ?, meeting_time = ?,
      fee = ?, passenger_fee = ?, capacity = ?, cutoff_at = ?, group_link = ?, notes = ?, status = ?,
      enable_attendance_type = ?, enable_car_role = ?, enable_plus_one = ?
     WHERE id = ? AND moderator_id = ?` // moderator_id repeated in WHERE, not just relying on the earlier getOwnedEvent check
  )
    .bind(
      body.title,
      body.organizer ?? null,
      body.endsAt,
      body.endsAt,
      body.activityLocation ?? null,
      body.meetingLocation ?? null,
      body.meetingTime ?? null,
      body.fee ?? null,
      body.passengerFee ?? null,
      body.capacity ?? null,
      body.cutoffAt ?? null,
      body.groupLink ?? null,
      body.notes ?? null,
      body.status ?? existing.status,
      body.enableAttendanceType ? 1 : 0,
      body.enableCarRole ? 1 : 0,
      body.enablePlusOne ? 1 : 0,
      id,
      moderator.id
    )
    .run()
  return c.json({ ok: true })
})

modRoutes.delete('/api/mod/events/:id', requireAuthenticated, requireApproved, requireCsrf, requireSameOrigin, async (c) => {
  const moderator = c.get('moderator')
  const id = c.req.param('id')!
  const existing = await getOwnedEvent(c.env.DB, moderator.id, id)
  if (!existing) return c.json({ error: 'not_found' }, 404)

  await c.env.DB.prepare('DELETE FROM registrations WHERE event_id = ?').bind(id).run()
  await c.env.DB.prepare('DELETE FROM events WHERE id = ? AND moderator_id = ?').bind(id, moderator.id).run()
  return c.json({ ok: true })
})

modRoutes.get('/api/mod/events/:id/roster', requireAuthenticated, requireApproved, async (c) => {
  const moderator = c.get('moderator')
  const id = c.req.param('id')!
  const existing = await getOwnedEvent(c.env.DB, moderator.id, id)
  if (!existing) return c.json({ error: 'not_found' }, 404)

  const rows = await c.env.DB.prepare(
    `SELECT line_user_id, display_name, picture_url, role, attendance_type, plus_one_count, hide_from_roster, created_at
     FROM registrations WHERE event_id = ? AND status = 'registered'
     ORDER BY created_at ASC`
  )
    .bind(id)
    .all()
  const cancelledRows = await c.env.DB.prepare(
    `SELECT line_user_id, display_name, role, attendance_type, plus_one_count, hide_from_roster, cancelled_by, updated_at
     FROM registrations WHERE event_id = ? AND status = 'cancelled' ORDER BY updated_at DESC`
  )
    .bind(id)
    .all()

  const results = rows.results as any[]
  const cancelledResults = cancelledRows.results as any[]
  const totalHeadcount = results.reduce((sum, r) => sum + 1 + (r.plus_one_count ?? 0), 0)

  return c.json({
    registeredCount: results.length,
    totalHeadcount,
    driverCount: results.filter((r) => r.role === 'driver').length,
    passengerCount: results.filter((r) => r.role === 'passenger').length,
    activityOnlyCount: results.filter((r) => r.attendance_type === 'activity_only').length,
    activityAndMealCount: results.filter((r) => r.attendance_type === 'activity_and_meal').length,
    mealOnlyCount: results.filter((r) => r.attendance_type === 'meal_only').length,
    cancelledCount: cancelledResults.length,
    enableAttendanceType: !!existing.enable_attendance_type,
    enableCarRole: !!existing.enable_car_role,
    enablePlusOne: !!existing.enable_plus_one,
    roster: results.map((r) => ({
      lineUserId: r.line_user_id,
      displayName: r.hide_from_roster ? null : r.display_name,
      pictureUrl: r.hide_from_roster ? null : r.picture_url,
      role: r.role,
      attendanceType: r.attendance_type,
      plusOneCount: r.plus_one_count ?? 0,
    })),
    cancelledRoster: cancelledResults.map((r) => ({
      lineUserId: r.line_user_id,
      displayName: r.hide_from_roster ? null : r.display_name,
      role: r.role,
      attendanceType: r.attendance_type,
      plusOneCount: r.plus_one_count ?? 0,
      cancelledBy: r.cancelled_by,
      cancelledAt: r.updated_at,
    })),
  })
})

modRoutes.put('/api/mod/events/:id/registrations/:lineUserId', requireAuthenticated, requireApproved, requireCsrf, requireSameOrigin, async (c) => {
  const moderator = c.get('moderator')
  const eventId = c.req.param('id')!
  const lineUserId = c.req.param('lineUserId')!
  const event = await getOwnedEvent(c.env.DB, moderator.id, eventId)
  if (!event) return c.json({ error: 'not_found' }, 404)
  const registration = await c.env.DB.prepare(
    `SELECT status FROM registrations WHERE event_id = ? AND line_user_id = ?`
  ).bind(eventId, lineUserId).first<{ status: string }>()
  if (!registration) return c.json({ error: 'not_found' }, 404)
  if (registration.status !== 'registered') return c.json({ error: 'not_registered' }, 409)

  const body = await c.req.json<{ role?: string | null; attendanceType?: string | null; plusOneCount?: number }>()
  if (body.role && !VALID_ROLES.has(body.role)) return c.json({ error: 'invalid_role' }, 400)
  if (body.attendanceType && !VALID_ATTENDANCE_TYPES.has(body.attendanceType)) return c.json({ error: 'invalid_attendance_type' }, 400)
  const plusOneCount = Math.max(0, Math.min(20, Math.floor(body.plusOneCount ?? 0)))
  if (!(await registrationFitsCapacity(c.env.DB, eventId, lineUserId, plusOneCount, event.capacity))) {
    return c.json({ error: 'full' }, 409)
  }

  await c.env.DB.prepare(
    `UPDATE registrations SET role = ?, attendance_type = ?, plus_one_count = ?, updated_at = datetime('now')
     WHERE event_id = ? AND line_user_id = ?`
  )
    .bind(body.role ?? null, body.attendanceType ?? null, plusOneCount, eventId, lineUserId)
    .run()
  await auditRegistrationAction(c.env.DB, eventId, lineUserId, moderator.id, 'edit')
  return c.json({ ok: true })
})

modRoutes.delete('/api/mod/events/:id/registrations/:lineUserId', requireAuthenticated, requireApproved, requireCsrf, requireSameOrigin, async (c) => {
  const moderator = c.get('moderator')
  const eventId = c.req.param('id')!
  const lineUserId = c.req.param('lineUserId')!
  const event = await getOwnedEvent(c.env.DB, moderator.id, eventId)
  if (!event) return c.json({ error: 'not_found' }, 404)
  const result = await c.env.DB.prepare(
    `UPDATE registrations SET status = 'cancelled', cancelled_by = 'moderator', updated_at = datetime('now')
     WHERE event_id = ? AND line_user_id = ? AND status = 'registered'`
  )
    .bind(eventId, lineUserId)
    .run()
  if (result.meta.changes === 0) return c.json({ error: 'not_found' }, 404)
  await auditRegistrationAction(c.env.DB, eventId, lineUserId, moderator.id, 'remove')
  return c.json({ ok: true })
})

modRoutes.post('/api/mod/events/:id/registrations/:lineUserId/restore', requireAuthenticated, requireApproved, requireCsrf, requireSameOrigin, async (c) => {
  const moderator = c.get('moderator')
  const eventId = c.req.param('id')!
  const lineUserId = c.req.param('lineUserId')!
  const event = await getOwnedEvent(c.env.DB, moderator.id, eventId)
  if (!event) return c.json({ error: 'not_found' }, 404)
  const registration = await c.env.DB.prepare(
    `SELECT status, plus_one_count FROM registrations WHERE event_id = ? AND line_user_id = ?`
  ).bind(eventId, lineUserId).first<{ status: string; plus_one_count: number }>()
  if (!registration) return c.json({ error: 'not_found' }, 404)
  if (registration.status !== 'cancelled') return c.json({ error: 'already_registered' }, 409)
  if (!(await registrationFitsCapacity(c.env.DB, eventId, lineUserId, registration.plus_one_count ?? 0, event.capacity))) {
    return c.json({ error: 'full' }, 409)
  }

  await c.env.DB.prepare(
    `UPDATE registrations SET status = 'registered', cancelled_by = NULL, updated_at = datetime('now')
     WHERE event_id = ? AND line_user_id = ?`
  )
    .bind(eventId, lineUserId)
    .run()
  await auditRegistrationAction(c.env.DB, eventId, lineUserId, moderator.id, 'restore')
  return c.json({ ok: true })
})
