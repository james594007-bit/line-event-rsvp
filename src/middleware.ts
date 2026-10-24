import type { Context, Next } from 'hono'
import { getCookie } from 'hono/cookie'
import { resolveSession, SESSION_COOKIE_NAME, type ModeratorRow } from './lib/session'
import { timingSafeEqual } from './lib/crypto'
import type { Bindings } from './bindings'

export const CSRF_COOKIE_NAME = 'csrf_token'

declare module 'hono' {
  interface ContextVariableMap {
    moderator: ModeratorRow
  }
}

/** Resolves the session cookie to a moderator of any status (pending/approved/rejected/suspended) — used where the caller needs to know "who is this" before deciding what they can do, e.g. GET /api/mod/me. */
export async function requireAuthenticated(c: Context<{ Bindings: Bindings }>, next: Next) {
  const token = getCookie(c, SESSION_COOKIE_NAME)
  const moderator = await resolveSession(c.env.DB, token)
  if (!moderator) return c.json({ error: 'unauthorized' }, 401)
  c.set('moderator', moderator)
  await next()
}

/** Stacks after requireAuthenticated: only an approved, non-suspended moderator may pass (FR-01 "預設拒絕" — pending/rejected/suspended all get the same generic denial, AC-02/AC-09). */
export async function requireApproved(c: Context, next: Next) {
  const moderator = c.get('moderator')
  if (!moderator || moderator.status !== 'approved') return c.json({ error: 'unauthorized' }, 401)
  await next()
}

/** Stacks after requireAuthenticated: only the platform owner may pass. */
export async function requireOwner(c: Context, next: Next) {
  const moderator = c.get('moderator')
  if (!moderator || moderator.role !== 'owner' || moderator.status !== 'approved') return c.json({ error: 'forbidden' }, 403)
  await next()
}

/** Double-submit CSRF check for state-changing requests (SameSite=Lax cookies are the first line of defense, this is defense-in-depth). */
export async function requireCsrf(c: Context, next: Next) {
  const cookieVal = getCookie(c, CSRF_COOKIE_NAME)
  const headerVal = c.req.header('x-csrf-token')
  if (!cookieVal || !headerVal || !timingSafeEqual(cookieVal, headerVal)) {
    return c.json({ error: 'csrf_check_failed' }, 403)
  }
  await next()
}

/** Rejects cross-origin writes outright (our admin/mod UIs are same-origin; there's no legitimate cross-origin caller for these endpoints). */
export async function requireSameOrigin(c: Context, next: Next) {
  const origin = c.req.header('origin')
  if (origin && origin !== new URL(c.req.url).origin) {
    return c.json({ error: 'cross_origin_blocked' }, 403)
  }
  await next()
}
