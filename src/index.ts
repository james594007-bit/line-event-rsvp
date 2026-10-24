import { Hono } from 'hono'
import { messagingApi } from '@line/bot-sdk'

type Bindings = {
  DB: D1Database
  ASSETS: Fetcher
  LIFF_ID: string
  LINE_CHANNEL_ACCESS_TOKEN: string
  LINE_CHANNEL_SECRET: string
}

const app = new Hono<{ Bindings: Bindings }>()

function randomId(prefix: string) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 10)}`
}

// ---- config for the LIFF page ----
app.get('/api/config', (c) => c.json({ liffId: c.env.LIFF_ID }))

// ---- create an event (no auth yet — see README) ----
app.post('/api/events', async (c) => {
  const body = await c.req.json<{
    title: string
    organizer?: string
    eventDate?: string
    meetingLocation?: string
    meetingTime?: string
    fee?: string
    passengerFee?: string
    capacity?: number
    cutoffAt?: string
    groupLink?: string
    notes?: string
    enableAttendanceType?: boolean
    enableCarRole?: boolean
    enablePlusOne?: boolean
  }>()
  if (!body.title) return c.json({ error: 'title required' }, 400)
  const id = randomId('ev')
  await c.env.DB.prepare(
    `INSERT INTO events
      (id, title, organizer, event_date, meeting_location, meeting_time, fee, passenger_fee, capacity, cutoff_at, group_link, notes,
       enable_attendance_type, enable_car_role, enable_plus_one)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      id,
      body.title,
      body.organizer ?? null,
      body.eventDate ?? null,
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

// ---- event info + live roster (public, no auth — this is deliberate) ----
app.get('/api/events/:id', async (c) => {
  const id = c.req.param('id')
  const event = await c.env.DB.prepare('SELECT * FROM events WHERE id = ?').bind(id).first()
  if (!event) return c.json({ error: 'not found' }, 404)
  return c.json(event)
})

app.get('/api/events/:id/roster', async (c) => {
  const id = c.req.param('id')
  const rows = await c.env.DB.prepare(
    `SELECT display_name, picture_url, role, attendance_type, plus_one_count, hide_from_roster, created_at
     FROM registrations WHERE event_id = ? AND status = 'registered'
     ORDER BY created_at ASC`
  )
    .bind(id)
    .all()
  const cancelled = await c.env.DB.prepare(
    `SELECT COUNT(*) as n FROM registrations WHERE event_id = ? AND status = 'cancelled'`
  )
    .bind(id)
    .first<{ n: number }>()

  const results = rows.results as any[]
  const totalHeadcount = results.reduce((sum, r) => sum + 1 + (r.plus_one_count ?? 0), 0)

  return c.json({
    registeredCount: results.length,
    totalHeadcount,
    driverCount: results.filter((r) => r.role === 'driver').length,
    passengerCount: results.filter((r) => r.role === 'passenger').length,
    activityOnlyCount: results.filter((r) => r.attendance_type === 'activity_only').length,
    activityAndMealCount: results.filter((r) => r.attendance_type === 'activity_and_meal').length,
    mealOnlyCount: results.filter((r) => r.attendance_type === 'meal_only').length,
    cancelledCount: cancelled?.n ?? 0,
    roster: results.map((r) => ({
      displayName: r.hide_from_roster ? null : r.display_name,
      pictureUrl: r.hide_from_roster ? null : r.picture_url,
      role: r.role,
      attendanceType: r.attendance_type,
      plusOneCount: r.plus_one_count ?? 0,
    })),
  })
})

// ---- register / cancel (dedup on event_id + line_user_id) ----
app.post('/api/events/:id/register', async (c) => {
  const id = c.req.param('id')
  const body = await c.req.json<{
    lineUserId: string
    displayName?: string
    pictureUrl?: string
    hide?: boolean
    role?: 'driver' | 'passenger'
    attendanceType?: 'activity_only' | 'activity_and_meal' | 'meal_only'
    plusOneCount?: number
  }>()
  if (!body.lineUserId) return c.json({ error: 'lineUserId required' }, 400)
  const plusOneCount = Math.max(0, Math.floor(body.plusOneCount ?? 0))

  const event = await c.env.DB.prepare('SELECT * FROM events WHERE id = ?').bind(id).first<any>()
  if (!event) return c.json({ error: 'not found' }, 404)
  if (event.status === 'closed') return c.json({ error: 'closed' }, 409)

  if (event.capacity) {
    // headcount from everyone else already registered (+1 per person, plus their companions)
    const others = await c.env.DB.prepare(
      `SELECT COALESCE(SUM(1 + plus_one_count), 0) as n FROM registrations
       WHERE event_id = ? AND status = 'registered' AND line_user_id != ?`
    )
      .bind(id, body.lineUserId)
      .first<{ n: number }>()
    const thisHeadcount = 1 + plusOneCount
    if ((others?.n ?? 0) + thisHeadcount > event.capacity) {
      return c.json({ error: 'full' }, 409)
    }
  }

  await c.env.DB.prepare(
    `INSERT INTO registrations
      (event_id, line_user_id, display_name, picture_url, role, attendance_type, plus_one_count, status, hide_from_roster, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'registered', ?, datetime('now'))
     ON CONFLICT(event_id, line_user_id) DO UPDATE SET
       status = 'registered', display_name = excluded.display_name,
       picture_url = excluded.picture_url, role = excluded.role,
       attendance_type = excluded.attendance_type, plus_one_count = excluded.plus_one_count,
       hide_from_roster = excluded.hide_from_roster,
       updated_at = datetime('now')`
  )
    .bind(
      id,
      body.lineUserId,
      body.displayName ?? null,
      body.pictureUrl ?? null,
      body.role ?? null,
      body.attendanceType ?? null,
      plusOneCount,
      body.hide ? 1 : 0
    )
    .run()

  return c.json({ ok: true })
})

app.post('/api/events/:id/cancel', async (c) => {
  const id = c.req.param('id')
  const body = await c.req.json<{ lineUserId: string }>()
  if (!body.lineUserId) return c.json({ error: 'lineUserId required' }, 400)
  await c.env.DB.prepare(
    `UPDATE registrations SET status = 'cancelled', updated_at = datetime('now')
     WHERE event_id = ? AND line_user_id = ?`
  )
    .bind(id, body.lineUserId)
    .run()
  return c.json({ ok: true })
})

// ---- organizer sets the small-group invite link once the group exists,
//      then every confirmed registrant gets it pushed 1:1 ----
app.post('/api/events/:id/invite-link', async (c) => {
  const id = c.req.param('id')
  const body = await c.req.json<{ groupInviteLink: string }>()
  if (!body.groupInviteLink) return c.json({ error: 'groupInviteLink required' }, 400)

  await c.env.DB.prepare('UPDATE events SET group_invite_link = ?, status = ? WHERE id = ?')
    .bind(body.groupInviteLink, 'closed', id)
    .run()

  const event = await c.env.DB.prepare('SELECT title FROM events WHERE id = ?').bind(id).first<any>()
  const registered = await c.env.DB.prepare(
    `SELECT line_user_id FROM registrations WHERE event_id = ? AND status = 'registered'`
  )
    .bind(id)
    .all<{ line_user_id: string }>()

  const client = new messagingApi.MessagingApiClient({ channelAccessToken: c.env.LINE_CHANNEL_ACCESS_TOKEN })
  const results = await Promise.allSettled(
    registered.results.map((r) =>
      client.pushMessage({
        to: r.line_user_id,
        messages: [
          {
            type: 'text',
            text: `「${event?.title ?? '活動'}」成團了!點這個連結加入活動群組:\n${body.groupInviteLink}`,
          },
        ],
      })
    )
  )
  const failed = results.filter((r) => r.status === 'rejected').length
  return c.json({ ok: true, sent: results.length - failed, failed })
})

// ---- LINE webhook (required by LINE console; not doing anything with inbound messages yet) ----
app.post('/webhook', async (c) => {
  const signature = c.req.header('x-line-signature')
  const bodyText = await c.req.text()
  if (!signature || !(await validSignature(bodyText, signature, c.env.LINE_CHANNEL_SECRET))) {
    return c.json({ error: 'invalid signature' }, 401)
  }
  return c.json({ ok: true })
})

async function validSignature(body: string, signature: string, channelSecret: string) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(channelSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body))
  const expected = btoa(String.fromCharCode(...new Uint8Array(mac)))
  return expected === signature
}

// ---- LIFF page, with per-event title/description for LINE's link-preview crawler ----
function escapeHtml(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

app.get('/liff', async (c) => {
  const eventId = c.req.query('event')
  let title = '活動報名系統'
  let description = '點開看看目前報名人數,一起參加吧'

  if (eventId) {
    const event = await c.env.DB.prepare('SELECT title, event_date, capacity FROM events WHERE id = ?')
      .bind(eventId)
      .first<any>()
    if (event) {
      title = event.title
      description = [event.event_date, event.capacity ? `限${event.capacity}人` : null].filter(Boolean).join(' · ') || description
    }
  }

  const assetRes = await c.env.ASSETS.fetch(new URL('/liff.html', c.req.url))
  let html = await assetRes.text()
  html = html.replace(
    '<title>活動報名</title>',
    `<title>${escapeHtml(title)}</title>
<meta property="og:title" content="${escapeHtml(title)}" />
<meta property="og:description" content="${escapeHtml(description)}" />`
  )
  return c.html(html)
})

// ---- everything else: static assets ----
app.get('*', (c) => c.env.ASSETS.fetch(c.req.raw))

export default app
