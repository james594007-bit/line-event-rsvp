export interface OwnedEventRow {
  id: string
  moderator_id: string
  title: string
  organizer: string | null
  event_date: string | null
  ends_at: string
  activity_location: string | null
  meeting_location: string | null
  meeting_time: string | null
  fee: string | null
  passenger_fee: string | null
  capacity: number | null
  cutoff_at: string | null
  group_link: string | null
  notes: string | null
  status: 'open' | 'full' | 'closed'
  enable_attendance_type: number
  enable_car_role: number
  enable_plus_one: number
  created_at: string
}

/**
 * Returns the event only if it belongs to this moderator — null both when
 * the event doesn't exist and when it belongs to someone else (AC-06: no
 * existence leak either way, caller should respond identically for both).
 */
export async function getOwnedEvent(db: D1Database, moderatorId: string, eventId: string): Promise<OwnedEventRow | null> {
  return db.prepare('SELECT * FROM events WHERE id = ? AND moderator_id = ?').bind(eventId, moderatorId).first<OwnedEventRow>()
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

export function isValidIsoDate(value: unknown): value is string {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) return false
  const d = new Date(`${value}T00:00:00.000Z`)
  return !Number.isNaN(d.getTime())
}
