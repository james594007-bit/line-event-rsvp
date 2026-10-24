import { describe, it, expect } from 'vitest'
import { buildAuthorizeUrl, exchangeCodeForIdToken, verifyIdToken, LineAuthError } from '../../src/lib/line-auth'

const config = { channelId: 'CHANNEL123', channelSecret: 'shh', redirectUri: 'https://example.workers.dev/auth/line/callback' }

function fakeFetch(status: number, body: unknown): typeof fetch {
  return (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch
}

describe('buildAuthorizeUrl', () => {
  it('includes PKCE challenge, state, nonce, and the configured redirect_uri', () => {
    const url = new URL(buildAuthorizeUrl(config, { state: 'S', nonce: 'N', codeChallenge: 'C' }))
    expect(url.origin + url.pathname).toBe('https://access.line.me/oauth2/v2.1/authorize')
    expect(url.searchParams.get('client_id')).toBe('CHANNEL123')
    expect(url.searchParams.get('redirect_uri')).toBe(config.redirectUri)
    expect(url.searchParams.get('state')).toBe('S')
    expect(url.searchParams.get('nonce')).toBe('N')
    expect(url.searchParams.get('code_challenge')).toBe('C')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('scope')).toBe('openid profile')
  })
})

describe('exchangeCodeForIdToken', () => {
  it('returns the id_token on success', async () => {
    const token = await exchangeCodeForIdToken(config, 'code123', 'verifier123', fakeFetch(200, { id_token: 'abc.def.ghi' }))
    expect(token).toBe('abc.def.ghi')
  })

  it('throws if the token endpoint rejects the request', async () => {
    await expect(exchangeCodeForIdToken(config, 'bad', 'v', fakeFetch(400, { error: 'invalid_grant' }))).rejects.toMatchObject({
      code: 'token_exchange_failed',
    })
  })

  it('throws if the response has no id_token (e.g. scope missing openid)', async () => {
    await expect(exchangeCodeForIdToken(config, 'code', 'v', fakeFetch(200, { access_token: 'x' }))).rejects.toMatchObject({
      code: 'no_id_token',
    })
  })
})

describe('verifyIdToken', () => {
  const validClaims = {
    iss: 'https://access.line.me',
    sub: 'U_abc123',
    aud: 'CHANNEL123',
    exp: Math.floor(Date.now() / 1000) + 3600,
    nonce: 'expected-nonce',
    name: '小明',
    picture: 'https://example.com/a.png',
  }

  it('accepts a valid token and returns the verified identity', async () => {
    const identity = await verifyIdToken(config, 'id.tok.en', 'expected-nonce', fakeFetch(200, validClaims))
    expect(identity).toEqual({ lineUserId: 'U_abc123', displayName: '小明', pictureUrl: 'https://example.com/a.png' })
  })

  it('rejects when the verify endpoint itself returns non-200', async () => {
    await expect(verifyIdToken(config, 't', 'expected-nonce', fakeFetch(400, {}))).rejects.toMatchObject({ code: 'id_token_invalid' })
  })

  it('rejects a wrong issuer', async () => {
    await expect(verifyIdToken(config, 't', 'expected-nonce', fakeFetch(200, { ...validClaims, iss: 'https://evil.example' }))).rejects.toThrow(
      'bad_issuer'
    )
  })

  it('rejects a wrong audience (token issued for a different channel)', async () => {
    await expect(verifyIdToken(config, 't', 'expected-nonce', fakeFetch(200, { ...validClaims, aud: 'SOME_OTHER_CHANNEL' }))).rejects.toThrow(
      'bad_audience'
    )
  })

  it('rejects an expired token', async () => {
    await expect(
      verifyIdToken(config, 't', 'expected-nonce', fakeFetch(200, { ...validClaims, exp: Math.floor(Date.now() / 1000) - 10 }))
    ).rejects.toThrow('expired')
  })

  it('rejects a nonce mismatch (replay protection)', async () => {
    await expect(verifyIdToken(config, 't', 'expected-nonce', fakeFetch(200, { ...validClaims, nonce: 'someone-elses-nonce' }))).rejects.toThrow(
      'bad_nonce'
    )
  })

  it('rejects a response with no nonce at all', async () => {
    const { nonce, ...withoutNonce } = validClaims
    await expect(verifyIdToken(config, 't', 'expected-nonce', fakeFetch(200, withoutNonce))).rejects.toThrow('bad_nonce')
  })

  it('rejects a response with no sub', async () => {
    const { sub, ...withoutSub } = validClaims
    await expect(verifyIdToken(config, 't', 'expected-nonce', fakeFetch(200, withoutSub))).rejects.toThrow('missing_sub')
  })
})
