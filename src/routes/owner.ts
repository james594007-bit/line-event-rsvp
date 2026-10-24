import { Hono } from 'hono'
import type { Bindings } from '../bindings'
import { requireAuthenticated, requireOwner, requireCsrf, requireSameOrigin } from '../middleware'
import { approveModerator, rejectModerator, suspendModerator, restoreModerator } from '../lib/moderators'
import { checkRateLimit } from '../lib/ratelimit'

export const ownerRoutes = new Hono<{ Bindings: Bindings }>()

const VALID_STATUSES = new Set(['pending', 'approved', 'rejected', 'suspended'])

// ---- list applicants/moderators, optionally filtered by status ----
// pending_display_name only has a value while status='pending' (FR-06) — it
// is NULL for every other status, so this never leaks it post-decision.
ownerRoutes.get('/api/owner/moderators', requireAuthenticated, requireOwner, async (c) => {
  const status = c.req.query('status')
  const query =
    status && VALID_STATUSES.has(status)
      ? c.env.DB.prepare('SELECT id, role, status, pending_display_name, applied_at, decided_at FROM moderators WHERE status = ? ORDER BY applied_at DESC').bind(status)
      : c.env.DB.prepare('SELECT id, role, status, pending_display_name, applied_at, decided_at FROM moderators ORDER BY applied_at DESC')
  const rows = await query.all()
  return c.json(rows.results)
})

// suspend_reason is intentionally only visible to the owner, and only on
// this single-record lookup (not the list above), matching FR-07.
ownerRoutes.get('/api/owner/moderators/:id', requireAuthenticated, requireOwner, async (c) => {
  const row = await c.env.DB.prepare(
    'SELECT id, role, status, pending_display_name, suspend_reason, applied_at, decided_at, decided_by FROM moderators WHERE id = ?'
  )
    .bind(c.req.param('id')!)
    .first()
  if (!row) return c.json({ error: 'not_found' }, 404)
  return c.json(row)
})

async function decisionRateLimitOk(db: D1Database, actorId: string): Promise<boolean> {
  const rl = await checkRateLimit(db, `owner_decision:${actorId}`, 30, 60)
  return rl.allowed
}

ownerRoutes.post('/api/owner/moderators/:id/approve', requireAuthenticated, requireOwner, requireCsrf, requireSameOrigin, async (c) => {
  const owner = c.get('moderator')
  if (!(await decisionRateLimitOk(c.env.DB, owner.id))) return c.json({ error: 'rate_limited' }, 429)
  const result = await approveModerator(c.env.DB, owner.id, c.req.param('id')!)
  if (!result.ok) return c.json({ error: result.reason }, result.reason === 'not_found' ? 404 : 409)
  return c.json({ ok: true })
})

ownerRoutes.post('/api/owner/moderators/:id/reject', requireAuthenticated, requireOwner, requireCsrf, requireSameOrigin, async (c) => {
  const owner = c.get('moderator')
  if (!(await decisionRateLimitOk(c.env.DB, owner.id))) return c.json({ error: 'rate_limited' }, 429)
  const result = await rejectModerator(c.env.DB, owner.id, c.req.param('id')!)
  if (!result.ok) return c.json({ error: result.reason }, result.reason === 'not_found' ? 404 : 409)
  return c.json({ ok: true })
})

ownerRoutes.post('/api/owner/moderators/:id/suspend', requireAuthenticated, requireOwner, requireCsrf, requireSameOrigin, async (c) => {
  const owner = c.get('moderator')
  if (!(await decisionRateLimitOk(c.env.DB, owner.id))) return c.json({ error: 'rate_limited' }, 429)
  const body = await c.req.json<{ reason?: string }>().catch(() => ({ reason: undefined }) as { reason?: string })
  const result = await suspendModerator(c.env.DB, owner.id, c.req.param('id')!, body.reason ?? null)
  if (!result.ok) return c.json({ error: result.reason }, result.reason === 'not_found' ? 404 : 409)
  return c.json({ ok: true })
})

ownerRoutes.post('/api/owner/moderators/:id/restore', requireAuthenticated, requireOwner, requireCsrf, requireSameOrigin, async (c) => {
  const owner = c.get('moderator')
  if (!(await decisionRateLimitOk(c.env.DB, owner.id))) return c.json({ error: 'rate_limited' }, 429)
  const result = await restoreModerator(c.env.DB, owner.id, c.req.param('id')!)
  if (!result.ok) return c.json({ error: result.reason }, result.reason === 'not_found' ? 404 : 409)
  return c.json({ ok: true })
})
