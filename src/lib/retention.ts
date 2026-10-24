// Retention policy per docs/OWNER-ACCESS-TECH-ASSESSMENT.md product decisions:
//   - registration PII: 90 days after the event's ends_at
//   - rejected moderator applications: 90 days after decided_at
//   - audit log: 1 year
//   - events themselves: 1 year after ends_at, de-identified aggregate kept
//
// All comparisons use `ends_at` (a mandatory ISO 8601 date on every event,
// added in migration 0003) rather than the free-text display date, so the
// sweep is driven by a value that's actually computable.

function isoDateDaysAgo(now: Date, days: number): string {
  const d = new Date(now.getTime() - days * 24 * 60 * 60 * 1000)
  return d.toISOString().slice(0, 10) // YYYY-MM-DD, comparable with events.ends_at
}

function isoDateTimeDaysAgo(now: Date, days: number): string {
  // matches SQLite's `datetime('now')` format (UTC, "YYYY-MM-DD HH:MM:SS")
  const d = new Date(now.getTime() - days * 24 * 60 * 60 * 1000)
  return d.toISOString().slice(0, 19).replace('T', ' ')
}

export interface RetentionSweepResult {
  dryRun: boolean
  archivedEventStats: number
  registrationsDeleted: number
  rejectedModeratorsDeleted: number
  auditLogRowsDeleted: number
  eventsDeleted: number
}

export async function runRetentionSweep(db: D1Database, now: Date = new Date(), options: { dryRun?: boolean } = {}): Promise<RetentionSweepResult> {
  const dryRun = options.dryRun ?? false
  const registrationCutoffDate = isoDateDaysAgo(now, 90) // events.ends_at <= this
  const rejectedCutoffDateTime = isoDateTimeDaysAgo(now, 90)
  const auditCutoffDateTime = isoDateTimeDaysAgo(now, 365)
  const eventCutoffDate = isoDateDaysAgo(now, 365)

  // 1. Archive aggregate stats for events about to lose their registration data,
  //    but only ones not already archived by an earlier sweep run.
  const toArchive = await db
    .prepare(
      `SELECT e.id, e.moderator_id, e.title, e.ends_at,
         COUNT(CASE WHEN r.status = 'registered' THEN 1 END) as registered_count,
         COALESCE(SUM(CASE WHEN r.status = 'registered' THEN 1 + r.plus_one_count END), 0) as total_headcount
       FROM events e
       LEFT JOIN registrations r ON r.event_id = e.id
       WHERE e.ends_at <= ?
         AND e.id NOT IN (SELECT event_id FROM event_archive_stats)
       GROUP BY e.id`
    )
    .bind(registrationCutoffDate)
    .all<{ id: string; moderator_id: string; title: string; ends_at: string; registered_count: number; total_headcount: number }>()

  if (!dryRun) {
    for (const ev of toArchive.results) {
      await db
        .prepare(
          `INSERT INTO event_archive_stats (event_id, moderator_id, title, ends_at, final_registered_count, final_total_headcount)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .bind(ev.id, ev.moderator_id, ev.title, ev.ends_at, ev.registered_count, ev.total_headcount)
        .run()
    }
  }

  // 2. Delete registrations for events past the 90-day mark.
  let registrationsDeleted = 0
  {
    const count = await db
      .prepare(`SELECT COUNT(*) as n FROM registrations WHERE event_id IN (SELECT id FROM events WHERE ends_at <= ?)`)
      .bind(registrationCutoffDate)
      .first<{ n: number }>()
    registrationsDeleted = count?.n ?? 0
    if (!dryRun && registrationsDeleted > 0) {
      await db.prepare(`DELETE FROM registrations WHERE event_id IN (SELECT id FROM events WHERE ends_at <= ?)`).bind(registrationCutoffDate).run()
    }
  }

  // 3. Delete rejected moderator applications past 90 days since decision.
  let rejectedModeratorsDeleted = 0
  {
    const count = await db
      .prepare(`SELECT COUNT(*) as n FROM moderators WHERE status = 'rejected' AND decided_at <= ?`)
      .bind(rejectedCutoffDateTime)
      .first<{ n: number }>()
    rejectedModeratorsDeleted = count?.n ?? 0
    if (!dryRun && rejectedModeratorsDeleted > 0) {
      await db.prepare(`DELETE FROM moderators WHERE status = 'rejected' AND decided_at <= ?`).bind(rejectedCutoffDateTime).run()
    }
  }

  // 4. Delete audit log rows past 1 year.
  let auditLogRowsDeleted = 0
  {
    const count = await db.prepare(`SELECT COUNT(*) as n FROM audit_log WHERE created_at <= ?`).bind(auditCutoffDateTime).first<{ n: number }>()
    auditLogRowsDeleted = count?.n ?? 0
    if (!dryRun && auditLogRowsDeleted > 0) {
      await db.prepare(`DELETE FROM audit_log WHERE created_at <= ?`).bind(auditCutoffDateTime).run()
    }
  }

  // 5. Delete events themselves past 1 year (their stats were archived in step 1
  //    of this or an earlier sweep run, long before they reach this threshold
  //    since 90 days always elapses before 365 does).
  let eventsDeleted = 0
  {
    const count = await db.prepare(`SELECT COUNT(*) as n FROM events WHERE ends_at <= ?`).bind(eventCutoffDate).first<{ n: number }>()
    eventsDeleted = count?.n ?? 0
    if (!dryRun && eventsDeleted > 0) {
      await db.prepare(`DELETE FROM events WHERE ends_at <= ?`).bind(eventCutoffDate).run()
    }
  }

  return {
    dryRun,
    archivedEventStats: toArchive.results.length,
    registrationsDeleted,
    rejectedModeratorsDeleted,
    auditLogRowsDeleted,
    eventsDeleted,
  }
}
