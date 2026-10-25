# ops/

Scripts in this directory are **manual and confirmation-gated** — nothing
here runs automatically. In particular, `npm run db:migrate:local` and
`npm run db:migrate:remote` only ever look at `migrations/`, never at this
directory.

## finalize-owner-access-not-null.sql

Promotes `events.moderator_id`/`events.ends_at` to `NOT NULL` and rebuilds
`registrations` alongside it (its foreign key must be re-declared against
the real final `events` table — see the comment block at the top of the
script for why this is necessary, not optional). This is the final schema
the application code and `test/setup.ts` already assume.

**Preconditions, in order:**

1. Back up the production D1 database:
   ```
   wrangler d1 export line_event_rsvp --remote --output backup-$(date +%Y%m%d).sql
   ```
   Then, before the file leaves the machine that ran the export:
   - **Move it outside this git repository** — it must never be committed,
     staged, or left in a directory that gets added to git.
   - **Encrypt it at rest** (e.g. `age -p backup-*.sql > backup-*.sql.age`,
     or `gpg -c backup-*.sql`), and delete the plaintext copy once the
     encrypted one exists.
   - **Confirm it's actually readable** — decrypt it (to a scratch
     location, not back into the repo) and spot-check that real rows come
     out — before treating it as a valid backup.
   - **Delete the backup 30 days after a cutover using it is confirmed
     successful.** Not before (you'd have nothing to restore from if
     something goes wrong in that window) and not indefinitely either.
   - No backup file, and no credential used to produce or decrypt it, is
     ever committed to this repository.
2. Run the precondition check at the top of the script by itself:
   ```sql
   SELECT COUNT(*) FROM events WHERE moderator_id IS NULL OR ends_at IS NULL;
   ```
   It must return `0`. If it doesn't: either backfill a real `ends_at` for
   those rows, or — per the approved product decision to clear
   pre-owner-access test data at the stage 5 cutover
   (`docs/OWNER-ACCESS-TECH-ASSESSMENT.md`, product decision #5) — delete
   them first. That deletion is its own explicit, separately-confirmed step,
   not something this file does.
3. Dry-run the script against a clean **local** D1 copy seeded with
   representative data, then run `PRAGMA foreign_key_check;` and confirm it
   returns zero rows, and that row counts / spot-checked values match the
   pre-rebuild data.

   **Already done once**, while implementing the `owner-access` branch —
   seeded 2 events (one moderator-owned, one under the legacy synthetic
   moderator) and 3 registrations (including a driver with `plus_one_count`
   and a cancelled one), ran the script locally, and confirmed:
   `PRAGMA foreign_key_check` returned 0 rows; `events`/`registrations` row
   counts and every registration's `display_name`/`role`/`plus_one_count`/
   `status` were unchanged; the new `registrations.event_id` FK clause
   read `REFERENCES events(id)` (not the stale `events_pre_not_null`); and
   `events_pre_not_null`/`registrations_pre_not_null` no longer existed
   afterward. **Re-run this dry run if the script changes again** —
   this result doesn't carry forward past an edit.
4. James has explicitly confirmed running this against the production
   database, in this session or a later one. Nothing in this repo should
   trigger it on its own.

Only once all four are satisfied, run the rebuild portion of the script
against the real database — then follow through on step 1's 30-day backup
deletion once that cutover is confirmed successful.

This file was never run against anything but a disposable local D1 instance
while implementing the `owner-access` branch — it has never touched the
production database.
