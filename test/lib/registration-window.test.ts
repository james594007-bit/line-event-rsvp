import { describe, expect, it } from 'vitest'
import { isRegistrationClosed, isValidTaipeiCutoff, parseTaipeiCutoff } from '../../src/lib/registration-window'

describe('registration window', () => {
  it('interprets cutoff times in Asia/Taipei', () => {
    expect(parseTaipeiCutoff('2026-10-31T23:59')?.toISOString()).toBe('2026-10-31T15:59:00.000Z')
  })

  it('closes at the configured time or when manually closed', () => {
    expect(isRegistrationClosed({ status: 'open', cutoff_at: '2026-10-31T23:59' }, new Date('2026-10-31T15:58:59Z'))).toBe(false)
    expect(isRegistrationClosed({ status: 'open', cutoff_at: '2026-10-31T23:59' }, new Date('2026-10-31T15:59:00Z'))).toBe(true)
    expect(isRegistrationClosed({ status: 'closed', cutoff_at: null })).toBe(true)
  })

  it('rejects the old display-only cutoff format', () => {
    expect(isValidTaipeiCutoff('10/31')).toBe(false)
  })
})
