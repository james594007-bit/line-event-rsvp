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
  const body = await c.req.json<{ title: string; capacity?: number; cutoffAt?: string }>()
  if (!body.title) return c.json({ error: 'title required' }, 400)
  const id = randomId('ev')
  await c.env.DB.prepare(
    'INSERT INTO events (id, title, capacity, cutoff_at) VALUES (?, ?, ?, ?)'
  )
    .bind(id, body.title, body.capacity ?? null, body.cutoffAt ?? null)
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
    `SELECT display_name, picture_url, hide_from_roster, created_at
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
  return c.json({
    registeredCount: rows.results.length,
    cancelledCount: cancelled?.n ?? 0,
    roster: rows.results.map((r: any) => ({
      displayName: r.hide_from_roster ? null : r.display_name,
      pictureUrl: r.hide_from_roster ? null : r.picture_url,
    })),
  })
})

// ---- register / cancel (dedup on event_id + line_user_id) ----
app.post('/api/events/:id/register', async (c) => {
  const id = c.req.param('id')
  const body = await c.req.json<{ lineUserId: string; displayName?: string; pictureUrl?: string; hide?: boolean }>()
  if (!body.lineUserId) return c.json({ error: 'lineUserId required' }, 400)

  const event = await c.env.DB.prepare('SELECT * FROM events WHERE id = ?').bind(id).first<any>()
  if (!event) return c.json({ error: 'not found' }, 404)
  if (event.status === 'closed') return c.json({ error: 'closed' }, 409)

  if (event.capacity) {
    const current = await c.env.DB.prepare(
      `SELECT COUNT(*) as n FROM registrations WHERE event_id = ? AND status = 'registered'`
    )
      .bind(id)
      .first<{ n: number }>()
    const alreadyIn = await c.env.DB.prepare(
      `SELECT status FROM registrations WHERE event_id = ? AND line_user_id = ?`
    )
      .bind(id, body.lineUserId)
      .first<{ status: string }>()
    const willBeNew = !alreadyIn || alreadyIn.status !== 'registered'
    if (willBeNew && (current?.n ?? 0) >= event.capacity) {
      return c.json({ error: 'full' }, 409)
    }
  }

  await c.env.DB.prepare(
    `INSERT INTO registrations (event_id, line_user_id, display_name, picture_url, status, hide_from_roster, updated_at)
     VALUES (?, ?, ?, ?, 'registered', ?, datetime('now'))
     ON CONFLICT(event_id, line_user_id) DO UPDATE SET
       status = 'registered', display_name = excluded.display_name,
       picture_url = excluded.picture_url, hide_from_roster = excluded.hide_from_roster,
       updated_at = datetime('now')`
  )
    .bind(id, body.lineUserId, body.displayName ?? null, body.pictureUrl ?? null, body.hide ? 1 : 0)
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

// ---- everything else: static LIFF page / assets ----
app.get('*', (c) => c.env.ASSETS.fetch(c.req.raw))

export default app
