// Whitelist (not blacklist) of event fields the public, unauthenticated
// participant-facing endpoints may return. Anything not listed here —
// moderator_id and ends_at included — never reaches a public response, even
// if a future column gets added to `events` and someone forgets to update
// this file's call sites (the point of a whitelist over picking columns out
// of SELECT *).

export interface EventRow {
  id: string
  title: string
  organizer: string | null
  event_date: string | null
  meeting_location: string | null
  meeting_time: string | null
  fee: string | null
  passenger_fee: string | null
  capacity: number | null
  cutoff_at: string | null
  group_link: string | null
  notes: string | null
  status: string
  enable_attendance_type: number
  enable_car_role: number
  enable_plus_one: number
  [key: string]: unknown
}

export function toPublicEvent(row: EventRow) {
  return {
    id: row.id,
    title: row.title,
    organizer: row.organizer,
    event_date: row.event_date,
    meeting_location: row.meeting_location,
    meeting_time: row.meeting_time,
    fee: row.fee,
    passenger_fee: row.passenger_fee,
    capacity: row.capacity,
    cutoff_at: row.cutoff_at,
    group_link: row.group_link,
    notes: row.notes,
    status: row.status,
    enable_attendance_type: row.enable_attendance_type,
    enable_car_role: row.enable_car_role,
    enable_plus_one: row.enable_plus_one,
  }
}
