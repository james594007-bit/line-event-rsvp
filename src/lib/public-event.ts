// Whitelist (not blacklist) of event fields the public, unauthenticated
// participant-facing endpoints may return. Anything not listed here —
// moderator_id and the internal ends_at field name never reach a public response, even
// if a future column gets added to `events` and someone forgets to update
// this file's call sites (the point of a whitelist over picking columns out
// of SELECT *).

export interface EventRow {
  id: string
  title: string
  organizer: string | null
  event_date: string | null
  ends_at?: string | null
  activity_location: string | null
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
    // The product has one activity date. Keep the public response key stable
    // for older clients while sourcing it from the canonical ISO date.
    event_date: row.ends_at ?? row.event_date,
    activity_location: row.activity_location ?? row.meeting_location,
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
