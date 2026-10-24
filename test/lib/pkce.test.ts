import { describe, it, expect } from 'vitest'
import { generatePkce, generateState, generateNonce } from '../../src/lib/pkce'
import { sha256Base64Url } from '../../src/lib/crypto'

describe('pkce', () => {
  it('generates a verifier/challenge pair where challenge = base64url(sha256(verifier))', async () => {
    const pair = await generatePkce()
    expect(pair.method).toBe('S256')
    expect(pair.verifier.length).toBeGreaterThanOrEqual(43)
    const expected = await sha256Base64Url(pair.verifier)
    expect(pair.challenge).toBe(expected)
  })

  it('generates different values on each call', async () => {
    const a = await generatePkce()
    const b = await generatePkce()
    expect(a.verifier).not.toBe(b.verifier)
    expect(a.challenge).not.toBe(b.challenge)
  })

  it('state and nonce are random and distinct', () => {
    expect(generateState()).not.toBe(generateState())
    expect(generateNonce()).not.toBe(generateNonce())
  })
})
