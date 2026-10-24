import { env } from 'cloudflare:test'
import { describe, it, expect, beforeEach } from 'vitest'
import { resetTestSchema } from '../setup'
import {
  applyAsModerator,
  approveModerator,
  rejectModerator,
  suspendModerator,
  restoreModerator,
  getModeratorById,
  ensureOwnerBootstrap,
} from '../../src/lib/moderators'
import { createSession, resolveSession } from '../../src/lib/session'

describe('moderator application + decisions', () => {
  beforeEach(async () => {
    await resetTestSchema(env.DB)
  })

  it('a first-time applicant gets a new pending row', async () => {
    const result = await applyAsModerator(env.DB, 'U_new')
    expect(result.outcome).toBe('created')
    const mod = await getModeratorById(env.DB, result.moderatorId)
    expect(mod?.status).toBe('pending')
  })

  it('re-applying while already pending is idempotent, not a duplicate (AC-03)', async () => {
    const first = await applyAsModerator(env.DB, 'U_dup')
    const second = await applyAsModerator(env.DB, 'U_dup')
    expect(second.outcome).toBe('already_pending')
    expect(second.moderatorId).toBe(first.moderatorId)
    const count = await env.DB.prepare('SELECT COUNT(*) as n FROM moderators WHERE line_user_id = ?').bind('U_dup').first<{ n: number }>()
    expect(count?.n).toBe(1)
  })

  it('applying while already approved reports already_active, does not reset status', async () => {
    const applied = await applyAsModerator(env.DB, 'U_active')
    const owner = await applyAsModerator(env.DB, 'U_owner_actor')
    await approveModerator(env.DB, owner.moderatorId, applied.moderatorId)

    const reapply = await applyAsModerator(env.DB, 'U_active')
    expect(reapply.outcome).toBe('already_active')
    const mod = await getModeratorById(env.DB, applied.moderatorId)
    expect(mod?.status).toBe('approved')
  })

  it('a rejected applicant can re-apply and goes back to pending (product decision: no cooldown)', async () => {
    const applied = await applyAsModerator(env.DB, 'U_rejected')
    const owner = await applyAsModerator(env.DB, 'U_owner_actor2')
    await rejectModerator(env.DB, owner.moderatorId, applied.moderatorId)

    const reapply = await applyAsModerator(env.DB, 'U_rejected')
    expect(reapply.outcome).toBe('reapplied')
    const mod = await getModeratorById(env.DB, applied.moderatorId)
    expect(mod?.status).toBe('pending')
    expect(mod?.decided_at).toBeNull()
  })

  it('approve only succeeds from pending', async () => {
    const applied = await applyAsModerator(env.DB, 'U_a')
    const owner = await applyAsModerator(env.DB, 'U_owner3')

    const result = await approveModerator(env.DB, owner.moderatorId, applied.moderatorId)
    expect(result.ok).toBe(true)
    expect((await getModeratorById(env.DB, applied.moderatorId))?.status).toBe('approved')
  })

  it('approve is idempotent when already approved', async () => {
    const applied = await applyAsModerator(env.DB, 'U_b')
    const owner = await applyAsModerator(env.DB, 'U_owner4')
    await approveModerator(env.DB, owner.moderatorId, applied.moderatorId)
    const second = await approveModerator(env.DB, owner.moderatorId, applied.moderatorId)
    expect(second.ok).toBe(true)
  })

  it('approve fails with wrong_state from rejected (not a silent success)', async () => {
    const applied = await applyAsModerator(env.DB, 'U_c')
    const owner = await applyAsModerator(env.DB, 'U_owner5')
    await rejectModerator(env.DB, owner.moderatorId, applied.moderatorId)
    const result = await approveModerator(env.DB, owner.moderatorId, applied.moderatorId)
    expect(result).toEqual({ ok: false, reason: 'wrong_state' })
  })

  it('suspend closes the moderator open events, keeps closed ones closed, and invalidates sessions', async () => {
    const applied = await applyAsModerator(env.DB, 'U_d')
    const owner = await applyAsModerator(env.DB, 'U_owner6')
    await approveModerator(env.DB, owner.moderatorId, applied.moderatorId)

    await env.DB.prepare(`INSERT INTO events (id, moderator_id, title, ends_at, status) VALUES ('ev_open', ?, 'Open event', '2099-01-01', 'open')`)
      .bind(applied.moderatorId)
      .run()
    await env.DB.prepare(`INSERT INTO events (id, moderator_id, title, ends_at, status) VALUES ('ev_closed', ?, 'Already closed', '2099-01-01', 'closed')`)
      .bind(applied.moderatorId)
      .run()

    const { token } = await createSession(env.DB, applied.moderatorId, 0)
    expect(await resolveSession(env.DB, token)).not.toBeNull()

    await suspendModerator(env.DB, owner.moderatorId, applied.moderatorId, 'testing')

    expect((await getModeratorById(env.DB, applied.moderatorId))?.status).toBe('suspended')
    expect((await env.DB.prepare('SELECT status FROM events WHERE id = ?').bind('ev_open').first<{ status: string }>())?.status).toBe('closed')
    expect((await env.DB.prepare('SELECT status FROM events WHERE id = ?').bind('ev_closed').first<{ status: string }>())?.status).toBe('closed')
    expect(await resolveSession(env.DB, token)).toBeNull() // AC-09: takes effect immediately
  })

  it('restore brings a suspended moderator back to approved without reopening their events', async () => {
    const applied = await applyAsModerator(env.DB, 'U_e')
    const owner = await applyAsModerator(env.DB, 'U_owner7')
    await approveModerator(env.DB, owner.moderatorId, applied.moderatorId)
    await env.DB.prepare(`INSERT INTO events (id, moderator_id, title, ends_at, status) VALUES ('ev_x', ?, 'X', '2099-01-01', 'open')`)
      .bind(applied.moderatorId)
      .run()
    await suspendModerator(env.DB, owner.moderatorId, applied.moderatorId, null)

    const result = await restoreModerator(env.DB, owner.moderatorId, applied.moderatorId)
    expect(result.ok).toBe(true)
    expect((await getModeratorById(env.DB, applied.moderatorId))?.status).toBe('approved')
    expect((await env.DB.prepare('SELECT status FROM events WHERE id = ?').bind('ev_x').first<{ status: string }>())?.status).toBe('closed')
  })

  it('every decision writes an audit_log row', async () => {
    const applied = await applyAsModerator(env.DB, 'U_f')
    const owner = await applyAsModerator(env.DB, 'U_owner8')
    await approveModerator(env.DB, owner.moderatorId, applied.moderatorId)
    await suspendModerator(env.DB, owner.moderatorId, applied.moderatorId, 'r')
    await restoreModerator(env.DB, owner.moderatorId, applied.moderatorId)

    const rows = await env.DB
      .prepare('SELECT event_type FROM audit_log WHERE target_moderator_id = ? ORDER BY id')
      .bind(applied.moderatorId)
      .all<{ event_type: string }>()
    expect(rows.results.map((r) => r.event_type)).toEqual(['apply', 'approve', 'suspend', 'restore'])
  })
})

describe('owner bootstrap', () => {
  beforeEach(async () => {
    await resetTestSchema(env.DB)
  })

  it('promotes a matching LINE user id to owner on first login', async () => {
    await ensureOwnerBootstrap(env.DB, 'U_realowner', 'U_realowner')
    const mod = await env.DB.prepare('SELECT * FROM moderators WHERE line_user_id = ?').bind('U_realowner').first<any>()
    expect(mod.role).toBe('owner')
    expect(mod.status).toBe('approved')
  })

  it('does nothing for a non-matching user id', async () => {
    await ensureOwnerBootstrap(env.DB, 'U_randomperson', 'U_realowner')
    const mod = await env.DB.prepare('SELECT * FROM moderators WHERE line_user_id = ?').bind('U_randomperson').first()
    expect(mod).toBeNull()
  })

  it('does nothing when the secret is not configured', async () => {
    await ensureOwnerBootstrap(env.DB, 'U_someone', undefined)
    const mod = await env.DB.prepare('SELECT * FROM moderators WHERE line_user_id = ?').bind('U_someone').first()
    expect(mod).toBeNull()
  })

  it('is idempotent and does not demote an already-owner on repeat logins', async () => {
    await ensureOwnerBootstrap(env.DB, 'U_realowner', 'U_realowner')
    await ensureOwnerBootstrap(env.DB, 'U_realowner', 'U_realowner')
    const count = await env.DB.prepare('SELECT COUNT(*) as n FROM moderators WHERE line_user_id = ?').bind('U_realowner').first<{ n: number }>()
    expect(count?.n).toBe(1)
  })
})
