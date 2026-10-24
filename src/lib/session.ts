import { randomToken, sha256Hex } from './crypto'

export const SESSION_COOKIE_NAME = 'mod_session'
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60 // 7 days

export interface ModeratorRow {
  id: string
  line_user_id: string
  role: 'owner' | 'moderator'
  status: 'pending' | 'approved' | 'rejected' | 'suspended'
  session_version: number
  applied_at: string
  decided_at: string | null
  decided_by: string | null
  suspend_reason: string | null
  created_at: string
}

/**
 * Creates a session row and returns the raw token to put in the cookie.
 * Only the SHA-256 hash of the token is ever persisted (D1 `sessions.id`).
 */
export async function createSession(db: D1Database, moderatorId: string, sessionVersion: number): Promise<{ token: string; expiresAt: string }> {
  const token = randomToken(32)
  const tokenHash = await sha256Hex(token)
  const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000).toISOString()
  await db
    .prepare('INSERT INTO sessions (id, moderator_id, session_version, expires_at) VALUES (?, ?, ?, ?)')
    .bind(tokenHash, moderatorId, sessionVersion, expiresAt)
    .run()
  return { token, expiresAt }
}

/**
 * Resolves a raw cookie token to the current moderator row, re-checking status
 * and session_version fresh on every call — this is what makes suspension take
 * effect on the very next request instead of waiting for the cookie to expire.
 * Returns null for: unknown/expired session, stale session_version (session
 * was issued before a suspend/restore bumped the counter), or no such moderator.
 */
export async function resolveSession(db: D1Database, rawToken: string | undefined): Promise<ModeratorRow | null> {
  if (!rawToken) return null
  const tokenHash = await sha256Hex(rawToken)
  const session = await db
    .prepare('SELECT moderator_id, session_version, expires_at FROM sessions WHERE id = ?')
    .bind(tokenHash)
    .first<{ moderator_id: string; session_version: number; expires_at: string }>()
  if (!session) return null
  if (new Date(session.expires_at).getTime() < Date.now()) {
    await db.prepare('DELETE FROM sessions WHERE id = ?').bind(tokenHash).run()
    return null
  }

  const moderator = await db.prepare('SELECT * FROM moderators WHERE id = ?').bind(session.moderator_id).first<ModeratorRow>()
  if (!moderator) return null
  if (moderator.session_version !== session.session_version) return null // revoked by a suspend/restore since issuance

  return moderator
}

export async function revokeSession(db: D1Database, rawToken: string | undefined): Promise<void> {
  if (!rawToken) return
  const tokenHash = await sha256Hex(rawToken)
  await db.prepare('DELETE FROM sessions WHERE id = ?').bind(tokenHash).run()
}

/**
 * Invalidates every existing session for a moderator immediately, by bumping
 * session_version (so any session row issued before this no longer matches)
 * and deleting the rows outright as a belt-and-braces cleanup. Call this on
 * suspend AND on restore (so restoring doesn't resurrect a pre-suspension
 * session someone else may have captured).
 */
export async function invalidateAllSessions(db: D1Database, moderatorId: string): Promise<number> {
  const updated = await db
    .prepare('UPDATE moderators SET session_version = session_version + 1 WHERE id = ? RETURNING session_version')
    .bind(moderatorId)
    .first<{ session_version: number }>()
  await db.prepare('DELETE FROM sessions WHERE moderator_id = ?').bind(moderatorId).run()
  return updated?.session_version ?? 0
}
