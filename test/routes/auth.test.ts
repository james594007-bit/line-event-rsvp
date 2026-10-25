import { env } from 'cloudflare:test'
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { resetTestSchema } from '../setup'
import { signPayload } from '../../src/lib/crypto'
import app from '../../src/index'

const ORIGIN = 'https://line-event-rsvp.example.workers.dev'

async function call(req: Request) {
  return app.fetch(req, env)
}

function extractCookieValue(setCookieHeader: string | null, name: string): string | null {
  if (!setCookieHeader) return null
  const match = setCookieHeader.match(new RegExp(`${name}=([^;]*)`))
  return match ? match[1] : null
}

describe('/auth/line/start', () => {
  beforeEach(async () => {
    await resetTestSchema(env.DB)
  })

  it('redirects to LINE with PKCE challenge/state/nonce, and sets a signed line_oauth cookie', async () => {
    const res = await call(new Request(`${ORIGIN}/auth/line/start`));
    expect(res.status).toBe(302)
    const location = new URL(res.headers.get('location')!)
    expect(location.origin + location.pathname).toBe('https://access.line.me/oauth2/v2.1/authorize')
    expect(location.searchParams.get('state')).toBeTruthy()
    expect(location.searchParams.get('nonce')).toBeTruthy()
    expect(location.searchParams.get('code_challenge')).toBeTruthy()
    expect(location.searchParams.get('code_challenge_method')).toBe('S256')

    const setCookie = res.headers.get('set-cookie')
    expect(setCookie).toContain('line_oauth=')
    expect(setCookie).toContain('HttpOnly')
    // cookie value must not be plain JSON — should be signed (base64.base64 shape)
    const cookieVal = extractCookieValue(setCookie, 'line_oauth')
    expect(cookieVal).not.toMatch(/^%7B/) // not url-encoded "{"
    expect(cookieVal!.split('.').length).toBe(2)
  })
})

describe('/auth/line/callback — bundle cookie integrity', () => {
  beforeEach(async () => {
    await resetTestSchema(env.DB)
  })

  it('rejects when there is no line_oauth cookie at all', async () => {
    const res = await call(new Request(`${ORIGIN}/auth/line/callback?state=x&code=y`))
    expect(res.status).toBe(400)
  })

  it('rejects a tampered cookie (signature no longer matches)', async () => {
    const startRes = await call(new Request(`${ORIGIN}/auth/line/start`))
    const cookieVal = extractCookieValue(startRes.headers.get('set-cookie'), 'line_oauth')!
    const [payload, sig] = cookieVal.split('.')
    const tampered = `${payload}x.${sig}` // corrupt the payload segment

    const location = new URL(startRes.headers.get('location')!)
    const res = await call(
      new Request(`${ORIGIN}/auth/line/callback?state=${location.searchParams.get('state')}&code=anycode`, {
        headers: { Cookie: `line_oauth=${tampered}` },
      })
    )
    expect(res.status).toBe(400)
  })

  it('rejects an expired cookie even with a correct signature', async () => {
    const expired = await signPayload(env.COOKIE_SIGNING_SECRET, { state: 's', nonce: 'n', verifier: 'v' }, -10)
    const res = await call(
      new Request(`${ORIGIN}/auth/line/callback?state=s&code=anycode`, { headers: { Cookie: `line_oauth=${expired}` } })
    )
    expect(res.status).toBe(400)
  })

  it('rejects a cookie signed with a different secret (forged by someone who does not know COOKIE_SIGNING_SECRET)', async () => {
    const forged = await signPayload('not-the-real-secret', { state: 's', nonce: 'n', verifier: 'v' }, 600)
    const res = await call(new Request(`${ORIGIN}/auth/line/callback?state=s&code=anycode`, { headers: { Cookie: `line_oauth=${forged}` } }))
    expect(res.status).toBe(400)
  })

  it('rejects when the query state does not match the signed cookie state (even though the cookie itself is validly signed)', async () => {
    const startRes = await call(new Request(`${ORIGIN}/auth/line/start`))
    const cookieVal = extractCookieValue(startRes.headers.get('set-cookie'), 'line_oauth')!
    const res = await call(
      new Request(`${ORIGIN}/auth/line/callback?state=some-other-state&code=anycode`, { headers: { Cookie: `line_oauth=${cookieVal}` } })
    )
    expect(res.status).toBe(400)
  })
})

describe('/auth/line/callback — happy path with a valid signed cookie (LINE network calls mocked)', () => {
  const originalFetch = globalThis.fetch

  beforeEach(async () => {
    await resetTestSchema(env.DB)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    globalThis.fetch = originalFetch
  })

  async function startAndGetBundle() {
    const startRes = await call(new Request(`${ORIGIN}/auth/line/start`))
    const location = new URL(startRes.headers.get('location')!)
    const cookieVal = extractCookieValue(startRes.headers.get('set-cookie'), 'line_oauth')!
    return { state: location.searchParams.get('state')!, nonce: location.searchParams.get('nonce')!, cookieVal }
  }

  function mockLineNetwork(nonce: string, lineUserId: string) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url
        if (url.includes('/oauth2/v2.1/token')) {
          return new Response(JSON.stringify({ id_token: 'fake.id.token' }), { status: 200 })
        }
        if (url.includes('/oauth2/v2.1/verify')) {
          return new Response(
            JSON.stringify({
              iss: 'https://access.line.me',
              sub: lineUserId,
              aud: env.LINE_LOGIN_CHANNEL_ID,
              exp: Math.floor(Date.now() / 1000) + 3600,
              nonce,
              name: 'Tester',
            }),
            { status: 200 }
          )
        }
        throw new Error(`unexpected fetch in test: ${url}`)
      })
    )
  }

  it('a brand-new LINE identity gets bridged to /mod-apply with a verified_identity cookie, NOT a session (login ≠ permission)', async () => {
    const { state, nonce, cookieVal } = await startAndGetBundle()
    mockLineNetwork(nonce, 'U_brandnew')

    const res = await call(
      new Request(`${ORIGIN}/auth/line/callback?state=${state}&code=anycode`, { headers: { Cookie: `line_oauth=${cookieVal}` }, redirect: 'manual' })
    )

    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/mod-apply')
    expect(res.headers.get('set-cookie')).toContain('verified_identity=')
    expect(res.headers.get('set-cookie')).not.toContain('mod_session=')

    const mod = await env.DB.prepare('SELECT * FROM moderators WHERE line_user_id = ?').bind('U_brandnew').first()
    expect(mod).toBeNull() // still no account — apply is a separate explicit step
  })

  it('an existing moderator gets a real session and lands on /mod', async () => {
    await env.DB.prepare(`INSERT INTO moderators (id, line_user_id, status) VALUES ('mod_existing', 'U_existing', 'approved')`).run()

    const { state, nonce, cookieVal } = await startAndGetBundle()
    mockLineNetwork(nonce, 'U_existing')

    const res = await call(
      new Request(`${ORIGIN}/auth/line/callback?state=${state}&code=anycode`, { headers: { Cookie: `line_oauth=${cookieVal}` }, redirect: 'manual' })
    )

    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/mod')
    expect(res.headers.get('set-cookie')).toContain('mod_session=')
  })

  it('rejects when the nonce LINE hands back does not match what was sent (replay protection still enforced end-to-end)', async () => {
    const { state, cookieVal } = await startAndGetBundle()
    mockLineNetwork('a-completely-different-nonce', 'U_whoever')

    const res = await call(new Request(`${ORIGIN}/auth/line/callback?state=${state}&code=anycode`, { headers: { Cookie: `line_oauth=${cookieVal}` } }))
    expect(res.status).toBe(400)
  })
})
