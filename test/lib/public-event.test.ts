import { describe, it, expect } from 'vitest'
import { toPublicEvent } from '../../src/lib/public-event'

describe('toPublicEvent', () => {
  it('strips moderator_id, ends_at, created_at, and any unknown internal field', () => {
    const row = {
      id: 'ev_1',
      moderator_id: 'mod_secret',
      title: 'Test',
      organizer: 'James',
      event_date: '10/29',
      ends_at: '2026-10-29',
      meeting_location: 'somewhere',
      meeting_time: '08:00',
      fee: 'free',
      passenger_fee: null,
      capacity: 10,
      cutoff_at: '10/28',
      group_link: null,
      notes: null,
      status: 'open',
      enable_attendance_type: 0,
      enable_car_role: 1,
      enable_plus_one: 0,
      created_at: '2026-10-24 00:00:00',
      some_future_internal_field: 'should never leak',
    }

    const pub = toPublicEvent(row as any)

    expect(pub).not.toHaveProperty('moderator_id')
    expect(pub).not.toHaveProperty('ends_at')
    expect(pub).not.toHaveProperty('created_at')
    expect(pub).not.toHaveProperty('some_future_internal_field')
    expect(pub.id).toBe('ev_1')
    expect(pub.title).toBe('Test')
    expect(pub.enable_car_role).toBe(1)
  })
})
