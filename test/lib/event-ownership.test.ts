import { env } from 'cloudflare:test'
import { describe, it, expect, beforeEach } from 'vitest'
import { resetTestSchema } from '../setup'
import { getOwnedEvent, isValidIsoDate } from '../../src/lib/event-ownership'

describe('isValidIsoDate', () => {
  it('accepts valid ISO dates', () => {
    expect(isValidIsoDate('2026-10-29')).toBe(true)
    expect(isValidIsoDate('2000-01-01')).toBe(true)
  })

  it('rejects free-text, wrong format, or impossible dates', () => {
    expect(isValidIsoDate('10/29(四)')).toBe(false)
    expect(isValidIsoDate('2026-13-01')).toBe(false)
    expect(isValidIsoDate('')).toBe(false)
    expect(isValidIsoDate(undefined)).toBe(false)
    expect(isValidIsoDate(12345)).toBe(false)
  })
})

describe('getOwnedEvent', () => {
  beforeEach(async () => {
    await resetTestSchema(env.DB)
    await env.DB.prepare(`INSERT INTO moderators (id, line_user_id, status) VALUES ('mod_a', 'U_a', 'approved')`).run()
    await env.DB.prepare(`INSERT INTO moderators (id, line_user_id, status) VALUES ('mod_b', 'U_b', 'approved')`).run()
    await env.DB.prepare(`INSERT INTO events (id, moderator_id, title, ends_at) VALUES ('ev_1', 'mod_a', 'A''s event', '2026-10-29')`).run()
  })

  it("returns the event when it belongs to the requesting moderator", async () => {
    const ev = await getOwnedEvent(env.DB, 'mod_a', 'ev_1')
    expect(ev?.id).toBe('ev_1')
  })

  it("returns null when the event belongs to a different moderator (no existence leak)", async () => {
    expect(await getOwnedEvent(env.DB, 'mod_b', 'ev_1')).toBeNull()
  })

  it('returns null for a nonexistent event id, same as the wrong-owner case', async () => {
    expect(await getOwnedEvent(env.DB, 'mod_a', 'ev_does_not_exist')).toBeNull()
  })
})
