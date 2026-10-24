import { env } from 'cloudflare:test'
import { describe, it, expect, beforeEach } from 'vitest'
import { resetTestSchema } from '../setup'
import { runRetentionSweep } from '../../src/lib/retention'

const NOW = new Date('2027-01-01T00:00:00.000Z')

function daysAgoIsoDate(days: number): string {
  return new Date(NOW.getTime() - days * 86400_000).toISOString().slice(0, 10)
}
function daysAgoIsoDateTime(days: number): string {
  return new Date(NOW.getTime() - days * 86400_000).toISOString().slice(0, 19).replace('T', ' ')
}

async function makeModerator(id: string, status = 'approved', decidedAt?: string, role: 'owner' | 'moderator' = 'moderator') {
  await env.DB.prepare(`INSERT INTO moderators (id, line_user_id, status, decided_at, role) VALUES (?, ?, ?, ?, ?)`)
    .bind(id, `U_${id}`, status, decidedAt ?? null, role)
    .run()
}

async function makeEvent(id: string, moderatorId: string, endsAt: string) {
  await env.DB.prepare(`INSERT INTO events (id, moderator_id, title, ends_at, capacity) VALUES (?, ?, ?, ?, 10)`)
    .bind(id, moderatorId, `Event ${id}`, endsAt)
    .run()
}

async function makeRegistration(eventId: string, lineUserId: string, plusOne = 0) {
  await env.DB.prepare(`INSERT INTO registrations (event_id, line_user_id, status, plus_one_count) VALUES (?, ?, 'registered', ?)`)
    .bind(eventId, lineUserId, plusOne)
    .run()
}

describe('retention sweep', () => {
  beforeEach(async () => {
    await resetTestSchema(env.DB)
    await makeModerator('mod_owner', 'approved', undefined, 'owner')
  })

  it('leaves registrations for events under 90 days old untouched', async () => {
    await makeEvent('ev_recent', 'mod_owner', daysAgoIsoDate(10))
    await makeRegistration('ev_recent', 'U_a')

    const result = await runRetentionSweep(env.DB, NOW)

    expect(result.registrationsDeleted).toBe(0)
    const remaining = await env.DB.prepare('SELECT COUNT(*) as n FROM registrations').first<{ n: number }>()
    expect(remaining?.n).toBe(1)
  })

  it('deletes registrations and archives stats for events at/past the 90-day mark', async () => {
    await makeEvent('ev_old', 'mod_owner', daysAgoIsoDate(91))
    await makeRegistration('ev_old', 'U_a', 2) // headcount 3
    await makeRegistration('ev_old', 'U_b', 0) // headcount 1

    const result = await runRetentionSweep(env.DB, NOW)

    expect(result.archivedEventStats).toBe(1)
    expect(result.registrationsDeleted).toBe(2)

    const remaining = await env.DB.prepare('SELECT COUNT(*) as n FROM registrations WHERE event_id = ?').bind('ev_old').first<{ n: number }>()
    expect(remaining?.n).toBe(0)

    const archive = await env.DB.prepare('SELECT * FROM event_archive_stats WHERE event_id = ?').bind('ev_old').first<any>()
    expect(archive.final_registered_count).toBe(2)
    expect(archive.final_total_headcount).toBe(4)
  })

  it('does not re-archive (or error) on a second sweep run', async () => {
    await makeEvent('ev_old2', 'mod_owner', daysAgoIsoDate(100))
    await makeRegistration('ev_old2', 'U_a')

    await runRetentionSweep(env.DB, NOW)
    const second = await runRetentionSweep(env.DB, NOW)

    expect(second.archivedEventStats).toBe(0) // already archived, no dupes
    const archiveCount = await env.DB.prepare('SELECT COUNT(*) as n FROM event_archive_stats').first<{ n: number }>()
    expect(archiveCount?.n).toBe(1)
  })

  it('keeps rejected applications under 90 days, deletes ones past it', async () => {
    await makeModerator('mod_rejected_recent', 'rejected', daysAgoIsoDateTime(10))
    await makeModerator('mod_rejected_old', 'rejected', daysAgoIsoDateTime(91))

    const result = await runRetentionSweep(env.DB, NOW)

    expect(result.rejectedModeratorsDeleted).toBe(1)
    expect(await env.DB.prepare('SELECT id FROM moderators WHERE id = ?').bind('mod_rejected_recent').first()).not.toBeNull()
    expect(await env.DB.prepare('SELECT id FROM moderators WHERE id = ?').bind('mod_rejected_old').first()).toBeNull()
  })

  it('keeps audit log under 1 year, deletes entries past it', async () => {
    await env.DB.prepare(`INSERT INTO audit_log (event_type, target_moderator_id, actor_moderator_id, result, created_at) VALUES ('approve','m','mod_owner','success', ?)`)
      .bind(daysAgoIsoDateTime(100))
      .run()
    await env.DB.prepare(`INSERT INTO audit_log (event_type, target_moderator_id, actor_moderator_id, result, created_at) VALUES ('approve','m','mod_owner','success', ?)`)
      .bind(daysAgoIsoDateTime(400))
      .run()

    const result = await runRetentionSweep(env.DB, NOW)

    expect(result.auditLogRowsDeleted).toBe(1)
    const remaining = await env.DB.prepare('SELECT COUNT(*) as n FROM audit_log').first<{ n: number }>()
    expect(remaining?.n).toBe(1)
  })

  it('deletes the event itself once it passes the 1-year mark (stats already archived)', async () => {
    await makeEvent('ev_ancient', 'mod_owner', daysAgoIsoDate(400))
    await makeRegistration('ev_ancient', 'U_a')

    const result = await runRetentionSweep(env.DB, NOW)

    expect(result.eventsDeleted).toBe(1)
    expect(await env.DB.prepare('SELECT id FROM events WHERE id = ?').bind('ev_ancient').first()).toBeNull()
    // de-identified stats survive the event row itself
    expect(await env.DB.prepare('SELECT event_id FROM event_archive_stats WHERE event_id = ?').bind('ev_ancient').first()).not.toBeNull()
  })

  it('dryRun reports counts without deleting anything', async () => {
    await makeEvent('ev_dry', 'mod_owner', daysAgoIsoDate(91))
    await makeRegistration('ev_dry', 'U_a')

    const result = await runRetentionSweep(env.DB, NOW, { dryRun: true })

    expect(result.dryRun).toBe(true)
    expect(result.registrationsDeleted).toBe(1)
    const remaining = await env.DB.prepare('SELECT COUNT(*) as n FROM registrations').first<{ n: number }>()
    expect(remaining?.n).toBe(1) // nothing actually deleted
    const archived = await env.DB.prepare('SELECT COUNT(*) as n FROM event_archive_stats').first<{ n: number }>()
    expect(archived?.n).toBe(0) // nothing actually archived either
  })
})
