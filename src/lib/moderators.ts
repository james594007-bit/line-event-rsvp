import { invalidateAllSessions } from './session'
import type { ModeratorRow } from './session'

function randomId(prefix: string) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 10)}`
}

export async function writeAudit(
  db: D1Database,
  params: { eventType: 'apply' | 'approve' | 'reject' | 'suspend' | 'restore'; targetModeratorId: string; actorModeratorId: string; result: 'success' | 'denied' }
) {
  await db
    .prepare('INSERT INTO audit_log (event_type, target_moderator_id, actor_moderator_id, result) VALUES (?, ?, ?, ?)')
    .bind(params.eventType, params.targetModeratorId, params.actorModeratorId, params.result)
    .run()
}

export async function getModeratorByLineUserId(db: D1Database, lineUserId: string): Promise<ModeratorRow | null> {
  return db.prepare('SELECT * FROM moderators WHERE line_user_id = ?').bind(lineUserId).first<ModeratorRow>()
}

export async function getModeratorById(db: D1Database, id: string): Promise<ModeratorRow | null> {
  return db.prepare('SELECT * FROM moderators WHERE id = ?').bind(id).first<ModeratorRow>()
}

export type ApplyResult =
  | { outcome: 'created'; moderatorId: string }
  | { outcome: 'already_pending'; moderatorId: string }
  | { outcome: 'reapplied'; moderatorId: string }
  | { outcome: 'already_active'; moderatorId: string; status: 'approved' | 'suspended' }

/**
 * Idempotent: a LINE account with an existing pending application gets the
 * same application back (AC-03), not a duplicate row — enforced structurally
 * via moderators.line_user_id UNIQUE plus the branching below, not a
 * database-level "one pending row" constraint (product decision: rejected
 * applicants may re-apply any time, with no cooldown — see tech assessment).
 */
export async function applyAsModerator(db: D1Database, lineUserId: string): Promise<ApplyResult> {
  const existing = await getModeratorByLineUserId(db, lineUserId)

  if (!existing) {
    const id = randomId('mod')
    await db.prepare('INSERT INTO moderators (id, line_user_id, status) VALUES (?, ?, ?)').bind(id, lineUserId, 'pending').run()
    await writeAudit(db, { eventType: 'apply', targetModeratorId: id, actorModeratorId: id, result: 'success' })
    return { outcome: 'created', moderatorId: id }
  }

  if (existing.status === 'pending') {
    return { outcome: 'already_pending', moderatorId: existing.id }
  }

  if (existing.status === 'approved' || existing.status === 'suspended') {
    return { outcome: 'already_active', moderatorId: existing.id, status: existing.status }
  }

  // status === 'rejected': allowed to re-apply (product decision: no cooldown, no cap)
  await db
    .prepare(`UPDATE moderators SET status = 'pending', applied_at = datetime('now'), decided_at = NULL, decided_by = NULL, suspend_reason = NULL WHERE id = ?`)
    .bind(existing.id)
    .run()
  await writeAudit(db, { eventType: 'apply', targetModeratorId: existing.id, actorModeratorId: existing.id, result: 'success' })
  return { outcome: 'reapplied', moderatorId: existing.id }
}

export type DecisionResult = { ok: true } | { ok: false; reason: 'not_found' | 'wrong_state' }

export async function approveModerator(db: D1Database, actorId: string, targetId: string): Promise<DecisionResult> {
  const target = await getModeratorById(db, targetId)
  if (!target) return { ok: false, reason: 'not_found' }
  if (target.status === 'approved') return { ok: true } // idempotent
  if (target.status !== 'pending') {
    await writeAudit(db, { eventType: 'approve', targetModeratorId: targetId, actorModeratorId: actorId, result: 'denied' })
    return { ok: false, reason: 'wrong_state' }
  }

  await db.prepare(`UPDATE moderators SET status = 'approved', decided_at = datetime('now'), decided_by = ? WHERE id = ?`).bind(actorId, targetId).run()
  await writeAudit(db, { eventType: 'approve', targetModeratorId: targetId, actorModeratorId: actorId, result: 'success' })
  return { ok: true }
}

export async function rejectModerator(db: D1Database, actorId: string, targetId: string): Promise<DecisionResult> {
  const target = await getModeratorById(db, targetId)
  if (!target) return { ok: false, reason: 'not_found' }
  if (target.status === 'rejected') return { ok: true } // idempotent
  if (target.status !== 'pending') {
    await writeAudit(db, { eventType: 'reject', targetModeratorId: targetId, actorModeratorId: actorId, result: 'denied' })
    return { ok: false, reason: 'wrong_state' }
  }

  await db.prepare(`UPDATE moderators SET status = 'rejected', decided_at = datetime('now'), decided_by = ? WHERE id = ?`).bind(actorId, targetId).run()
  await writeAudit(db, { eventType: 'reject', targetModeratorId: targetId, actorModeratorId: actorId, result: 'success' })
  return { ok: true }
}

/**
 * Suspension stops NEW registrations on the moderator's events but leaves
 * them viewable, and the cancel endpoint keeps working for people already
 * registered (product decision). Implemented by flipping any of their
 * currently-open events to 'closed' — the existing register/cancel
 * endpoints already honor that status split (register checks status,
 * cancel does not), so no change needed there.
 */
export async function suspendModerator(db: D1Database, actorId: string, targetId: string, reason: string | null): Promise<DecisionResult> {
  const target = await getModeratorById(db, targetId)
  if (!target) return { ok: false, reason: 'not_found' }
  if (target.status === 'suspended') return { ok: true } // idempotent
  if (target.status !== 'approved') {
    await writeAudit(db, { eventType: 'suspend', targetModeratorId: targetId, actorModeratorId: actorId, result: 'denied' })
    return { ok: false, reason: 'wrong_state' }
  }

  await db.prepare(`UPDATE moderators SET status = 'suspended', suspend_reason = ?, decided_at = datetime('now'), decided_by = ? WHERE id = ?`).bind(reason, actorId, targetId).run()
  await db.prepare(`UPDATE events SET status = 'closed' WHERE moderator_id = ? AND status = 'open'`).bind(targetId).run()
  await invalidateAllSessions(db, targetId)
  await writeAudit(db, { eventType: 'suspend', targetModeratorId: targetId, actorModeratorId: actorId, result: 'success' })
  return { ok: true }
}

/** Does not reopen events that were auto-closed by suspension — the moderator can reopen individually if they still want to run them. */
export async function restoreModerator(db: D1Database, actorId: string, targetId: string): Promise<DecisionResult> {
  const target = await getModeratorById(db, targetId)
  if (!target) return { ok: false, reason: 'not_found' }
  if (target.status === 'approved') return { ok: true } // idempotent
  if (target.status !== 'suspended') {
    await writeAudit(db, { eventType: 'restore', targetModeratorId: targetId, actorModeratorId: actorId, result: 'denied' })
    return { ok: false, reason: 'wrong_state' }
  }

  await db.prepare(`UPDATE moderators SET status = 'approved', decided_at = datetime('now'), decided_by = ? WHERE id = ?`).bind(actorId, targetId).run()
  await writeAudit(db, { eventType: 'restore', targetModeratorId: targetId, actorModeratorId: actorId, result: 'success' })
  return { ok: true }
}

/**
 * Bootstraps the first owner: a verified LINE user id matching the
 * OWNER_LINE_USER_ID secret becomes (or is marked as) the owner on their
 * first login. Only ever promotes — never demotes an existing owner, and
 * never does anything for a non-matching user id.
 */
export async function ensureOwnerBootstrap(db: D1Database, lineUserId: string, ownerLineUserIdSecret: string | undefined): Promise<void> {
  if (!ownerLineUserIdSecret || lineUserId !== ownerLineUserIdSecret) return
  const existing = await getModeratorByLineUserId(db, lineUserId)
  if (existing) {
    if (existing.role !== 'owner') {
      await db.prepare(`UPDATE moderators SET role = 'owner', status = 'approved' WHERE id = ?`).bind(existing.id).run()
    }
    return
  }
  const id = randomId('mod')
  await db
    .prepare(`INSERT INTO moderators (id, line_user_id, role, status, decided_at) VALUES (?, ?, 'owner', 'approved', datetime('now'))`)
    .bind(id, lineUserId)
    .run()
}
