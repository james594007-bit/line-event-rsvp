import { describe, it, expect } from 'vitest'
import { signPayload, verifyPayload, hmacSign, timingSafeEqual, randomToken, sha256Hex } from '../../src/lib/crypto'

describe('signed payload (cookie bridging)', () => {
  it('round-trips a payload signed and verified with the same secret', async () => {
    const token = await signPayload('secret1', { lineUserId: 'U_abc', displayName: '小明' }, 600)
    const payload = await verifyPayload<{ lineUserId: string; displayName: string }>('secret1', token)
    expect(payload?.lineUserId).toBe('U_abc')
    expect(payload?.displayName).toBe('小明')
  })

  it('rejects a payload verified with the wrong secret', async () => {
    const token = await signPayload('secret1', { lineUserId: 'U_abc' }, 600)
    expect(await verifyPayload('wrong-secret', token)).toBeNull()
  })

  it('rejects a tampered payload (changed base64 segment, signature no longer matches)', async () => {
    const token = await signPayload('secret1', { lineUserId: 'U_victim' }, 600)
    const [, sig] = token.split('.')
    const forged = (await import('../../src/lib/crypto')).toBase64Url(new TextEncoder().encode(JSON.stringify({ lineUserId: 'U_attacker', exp: 9999999999 })))
    expect(await verifyPayload('secret1', `${forged}.${sig}`)).toBeNull()
  })

  it('rejects an expired payload', async () => {
    const token = await signPayload('secret1', { lineUserId: 'U_abc' }, -10) // already expired
    expect(await verifyPayload('secret1', token)).toBeNull()
  })

  it('rejects malformed/missing values', async () => {
    expect(await verifyPayload('secret1', undefined)).toBeNull()
    expect(await verifyPayload('secret1', 'not-a-valid-token')).toBeNull()
    expect(await verifyPayload('secret1', '')).toBeNull()
  })
})

describe('hmacSign + timingSafeEqual', () => {
  it('same input/secret produces the same signature deterministically', async () => {
    const a = await hmacSign('k', 'v')
    const b = await hmacSign('k', 'v')
    expect(a).toBe(b)
    expect(timingSafeEqual(a, b)).toBe(true)
  })

  it('different secrets produce different signatures', async () => {
    const a = await hmacSign('k1', 'v')
    const b = await hmacSign('k2', 'v')
    expect(a).not.toBe(b)
  })
})

describe('randomToken / sha256Hex', () => {
  it('randomToken is unique across calls', () => {
    expect(randomToken()).not.toBe(randomToken())
  })

  it('sha256Hex is deterministic', async () => {
    expect(await sha256Hex('hello')).toBe(await sha256Hex('hello'))
    expect(await sha256Hex('hello')).not.toBe(await sha256Hex('world'))
  })
})
