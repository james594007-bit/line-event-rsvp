import { env } from 'cloudflare:test'
import { describe, it, expect, beforeEach } from 'vitest'
import { resetTestSchema } from '../setup'
import { createSession, resolveSession, revokeSession, invalidateAllSessions } from '../../src/lib/session'

async function makeModerator(status: 'pending' | 'approved' | 'rejected' | 'suspended' = 'approved') {
  const id = `mod_${crypto.randomUUID().slice(0, 8)}`
  await env.DB.prepare(`INSERT INTO moderators (id, line_user_id, status) VALUES (?, ?, ?)`)
    .bind(id, `U_${id}`, status)
    .run()
  return id
}

describe('session lifecycle', () => {
  beforeEach(async () => {
    await resetTestSchema(env.DB)
  })

  it('creates a session and resolves it back to the moderator', async () => {
    const modId = await makeModerator()
    const { token } = await createSession(env.DB, modId, 0)
    const resolved = await resolveSession(env.DB, token)
    expect(resolved?.id).toBe(modId)
  })

  it('never stores the raw token — only its hash', async () => {
    const modId = await makeModerator()
    const { token } = await createSession(env.DB, modId, 0)
    const rows = await env.DB.prepare('SELECT id FROM sessions').all<{ id: string }>()
    expect(rows.results.some((r) => r.id === token)).toBe(false)
  })

  it('returns null for an unknown token', async () => {
    const resolved = await resolveSession(env.DB, 'not-a-real-token')
    expect(resolved).toBeNull()
  })

  it('returns null for an expired session', async () => {
    const modId = await makeModerator()
    const { token } = await createSession(env.DB, modId, 0)
    // force-expire it
    await env.DB.prepare("UPDATE sessions SET expires_at = datetime('now', '-1 hour')").run()
    const resolved = await resolveSession(env.DB, token)
    expect(resolved).toBeNull()
  })

  it('revoking a session makes it unresolvable', async () => {
    const modId = await makeModerator()
    const { token } = await createSession(env.DB, modId, 0)
    await revokeSession(env.DB, token)
    expect(await resolveSession(env.DB, token)).toBeNull()
  })

  it('invalidateAllSessions immediately breaks an existing session (suspend-takes-effect-now)', async () => {
    const modId = await makeModerator()
    const { token } = await createSession(env.DB, modId, 0)
    expect(await resolveSession(env.DB, token)).not.toBeNull()

    await invalidateAllSessions(env.DB, modId)

    // the already-issued cookie's session_version (0) no longer matches
    expect(await resolveSession(env.DB, token)).toBeNull()
  })

  it('a session issued after invalidation (new session_version) still works', async () => {
    const modId = await makeModerator()
    const newVersion = await invalidateAllSessions(env.DB, modId)
    const { token } = await createSession(env.DB, modId, newVersion)
    expect(await resolveSession(env.DB, token)).not.toBeNull()
  })

  it('the moderators FK prevents deleting a moderator while sessions still reference it (sessions must be revoked first)', async () => {
    const modId = await makeModerator()
    await createSession(env.DB, modId, 0)
    await expect(env.DB.prepare('DELETE FROM moderators WHERE id = ?').bind(modId).run()).rejects.toThrow()
  })
})
