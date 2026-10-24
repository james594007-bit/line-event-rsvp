import { env } from 'cloudflare:test'
import { describe, it, expect, beforeEach } from 'vitest'
import { resetTestSchema } from '../setup'
import { checkRateLimit } from '../../src/lib/ratelimit'

describe('rate limiting', () => {
  beforeEach(async () => {
    await resetTestSchema(env.DB)
  })

  it('allows requests under the limit', async () => {
    const now = 1_700_000_000
    const r1 = await checkRateLimit(env.DB, 'login:1.2.3.4', 3, 60, now)
    const r2 = await checkRateLimit(env.DB, 'login:1.2.3.4', 3, 60, now + 1)
    const r3 = await checkRateLimit(env.DB, 'login:1.2.3.4', 3, 60, now + 2)
    expect(r1.allowed).toBe(true)
    expect(r2.allowed).toBe(true)
    expect(r3.allowed).toBe(true)
  })

  it('blocks once the limit is exceeded within the window', async () => {
    const now = 1_700_000_000
    await checkRateLimit(env.DB, 'login:5.5.5.5', 2, 60, now)
    await checkRateLimit(env.DB, 'login:5.5.5.5', 2, 60, now + 1)
    const third = await checkRateLimit(env.DB, 'login:5.5.5.5', 2, 60, now + 2)
    expect(third.allowed).toBe(false)
    expect(third.remaining).toBe(0)
  })

  it('resets once the window rolls over', async () => {
    const now = 1_700_000_000
    await checkRateLimit(env.DB, 'login:9.9.9.9', 1, 60, now)
    const blocked = await checkRateLimit(env.DB, 'login:9.9.9.9', 1, 60, now + 10)
    expect(blocked.allowed).toBe(false)

    const nextWindow = await checkRateLimit(env.DB, 'login:9.9.9.9', 1, 60, now + 61)
    expect(nextWindow.allowed).toBe(true)
  })

  it('keeps separate counters per key', async () => {
    const now = 1_700_000_000
    await checkRateLimit(env.DB, 'login:A', 1, 60, now)
    const other = await checkRateLimit(env.DB, 'login:B', 1, 60, now)
    expect(other.allowed).toBe(true)
  })
})
