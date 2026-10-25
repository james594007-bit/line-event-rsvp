import { describe, expect, it } from 'vitest'
import { eventIdFromSearch, eventPreviewDescription } from '../../src/lib/link-preview'

describe('event link preview', () => {
  it('finds an event ID from a direct event query', () => {
    expect(eventIdFromSearch('?event=ev_direct')).toBe('ev_direct')
  })

  it('finds an event ID after LINE wraps it in liff.state', () => {
    expect(eventIdFromSearch('?liff.state=%3Fevent%3Dev_wrapped')).toBe('ev_wrapped')
  })

  it('shows the date and location before someone opens the link', () => {
    expect(eventPreviewDescription({ eventDate: '2026-10-31', meetingLocation: '迴龍捷運站３號出口', capacity: 10 })).toBe(
      '日期：2026-10-31 · 地點：迴龍捷運站３號出口 · 限10人'
    )
  })
})
