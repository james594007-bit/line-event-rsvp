import { createSession } from '../src/lib/session'
import { randomToken } from '../src/lib/crypto'

export async function makeModeratorWithSession(
  db: D1Database,
  opts: { status?: 'pending' | 'approved' | 'rejected' | 'suspended'; role?: 'owner' | 'moderator' } = {}
) {
  const id = `mod_${crypto.randomUUID().slice(0, 8)}`
  const lineUserId = `U_${id}`
  await db
    .prepare('INSERT INTO moderators (id, line_user_id, role, status) VALUES (?, ?, ?, ?)')
    .bind(id, lineUserId, opts.role ?? 'moderator', opts.status ?? 'approved')
    .run()
  const { token } = await createSession(db, id, 0)
  const csrfToken = randomToken(16)
  return {
    moderatorId: id,
    cookieHeader: `mod_session=${token}; csrf_token=${csrfToken}`,
    csrfToken,
  }
}

export const ORIGIN = 'https://line-event-rsvp.example.workers.dev'

export function authedRequest(path: string, session: { cookieHeader: string; csrfToken: string }, init: RequestInit = {}) {
  const headers = new Headers(init.headers)
  headers.set('Cookie', session.cookieHeader)
  if (init.method && init.method !== 'GET') {
    headers.set('X-CSRF-Token', session.csrfToken)
    headers.set('Origin', ORIGIN)
    if (!headers.has('Content-Type') && init.body) headers.set('Content-Type', 'application/json')
  }
  return new Request(`${ORIGIN}${path}`, { ...init, headers })
}
