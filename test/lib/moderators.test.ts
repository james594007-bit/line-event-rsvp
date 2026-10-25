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

  describe('batch atomicity: a failure on the last statement rolls back the earlier ones', () => {
    // Each decision's batch ends with the audit_log INSERT. Dropping that
    // table makes exactly that last statement fail, so a *passing* test
    // here only proves anything if the earlier statement(s) are confirmed
    // NOT to have taken effect — if D1's batch didn't roll back, the status
    // change would still show up even though the whole call threw.

    it('approve: a failing batch leaves the applicant still pending, not approved', async () => {
      const applied = await applyAsModerator(env.DB, 'U_rollback_approve')
      const owner = await applyAsModerator(env.DB, 'U_owner_rollback_approve')
      await env.DB.prepare('DROP TABLE audit_log').run()

      await expect(approveModerator(env.DB, owner.moderatorId, applied.moderatorId)).rejects.toThrow()

      const mod = await env.DB.prepare('SELECT status, decided_at FROM moderators WHERE id = ?').bind(applied.moderatorId).first<{ status: string; decided_at: string | null }>()
      expect(mod?.status).toBe('pending') // not 'approved' — the UPDATE did not commit
      expect(mod?.decided_at).toBeNull()
    })

    it('reject: a failing batch leaves the applicant still pending, not rejected', async () => {
      const applied = await applyAsModerator(env.DB, 'U_rollback_reject')
      const owner = await applyAsModerator(env.DB, 'U_owner_rollback_reject')
      await env.DB.prepare('DROP TABLE audit_log').run()

      await expect(rejectModerator(env.DB, owner.moderatorId, applied.moderatorId)).rejects.toThrow()

      const mod = await env.DB.prepare('SELECT status FROM moderators WHERE id = ?').bind(applied.moderatorId).first<{ status: string }>()
      expect(mod?.status).toBe('pending')
    })

    it('restore: a failing batch leaves the moderator still suspended, not approved', async () => {
      const applied = await applyAsModerator(env.DB, 'U_rollback_restore')
      const owner = await applyAsModerator(env.DB, 'U_owner_rollback_restore')
      await approveModerator(env.DB, owner.moderatorId, applied.moderatorId)
      await suspendModerator(env.DB, owner.moderatorId, applied.moderatorId, null)
      await env.DB.prepare('DROP TABLE audit_log').run()

      await expect(restoreModerator(env.DB, owner.moderatorId, applied.moderatorId)).rejects.toThrow()

      const mod = await env.DB.prepare('SELECT status FROM moderators WHERE id = ?').bind(applied.moderatorId).first<{ status: string }>()
      expect(mod?.status).toBe('suspended') // not 'approved' — restore did not commit
    })

    it('suspend: a failing batch leaves status/events/session_version/sessions all untouched', async () => {
      const applied = await applyAsModerator(env.DB, 'U_rollback_suspend')
      const owner = await applyAsModerator(env.DB, 'U_owner_rollback_suspend')
      await approveModerator(env.DB, owner.moderatorId, applied.moderatorId)

      await env.DB
        .prepare(`INSERT INTO events (id, moderator_id, title, ends_at, status) VALUES ('ev_rollback', ?, 'Rollback test event', '2099-01-01', 'open')`)
        .bind(applied.moderatorId)
        .run()
      const { token } = await createSession(env.DB, applied.moderatorId, 0)

      await env.DB.prepare('DROP TABLE audit_log').run()

      await expect(suspendModerator(env.DB, owner.moderatorId, applied.moderatorId, 'should not stick')).rejects.toThrow()

      const mod = await env.DB
        .prepare('SELECT status, session_version, suspend_reason FROM moderators WHERE id = ?')
        .bind(applied.moderatorId)
        .first<{ status: string; session_version: number; suspend_reason: string | null }>()
      expect(mod?.status).toBe('approved') // not 'suspended'
      expect(mod?.session_version).toBe(0) // not bumped
      expect(mod?.suspend_reason).toBeNull() // not set

      const event = await env.DB.prepare('SELECT status FROM events WHERE id = ?').bind('ev_rollback').first<{ status: string }>()
      expect(event?.status).toBe('open') // not 'closed'

      // the session the moderator already held must still resolve — the
      // DELETE FROM sessions in that same batch must not have committed
      expect(await resolveSession(env.DB, token)).not.toBeNull()
    })
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
