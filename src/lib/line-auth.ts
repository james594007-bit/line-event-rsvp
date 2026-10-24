// Standard LINE Login v2.1 OAuth/OIDC web flow, with PKCE.
//
// Deliberately NOT doing local JWT/JWKS verification of the id_token — LINE's
// own POST /oauth2/v2.1/verify endpoint validates the signature server-side
// and hands back the decoded claims, which is the officially documented way
// to verify an id_token for the web login flow and avoids us having to
// implement/maintain JWS verification ourselves. We still independently
// re-check iss/aud/exp/nonce on the claims it returns rather than trusting
// the 200 status alone.

export class LineAuthError extends Error {
  constructor(public code: string, message?: string) {
    super(message ?? code)
  }
}

export interface LineAuthConfig {
  channelId: string
  channelSecret: string
  redirectUri: string
}

export function buildAuthorizeUrl(
  config: Pick<LineAuthConfig, 'channelId' | 'redirectUri'>,
  params: { state: string; nonce: string; codeChallenge: string }
): string {
  const url = new URL('https://access.line.me/oauth2/v2.1/authorize')
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', config.channelId)
  url.searchParams.set('redirect_uri', config.redirectUri)
  url.searchParams.set('state', params.state)
  url.searchParams.set('scope', 'openid profile')
  url.searchParams.set('nonce', params.nonce)
  url.searchParams.set('code_challenge', params.codeChallenge)
  url.searchParams.set('code_challenge_method', 'S256')
  return url.toString()
}

type Fetcher = typeof fetch

export async function exchangeCodeForIdToken(
  config: LineAuthConfig,
  code: string,
  codeVerifier: string,
  fetchImpl: Fetcher = fetch
): Promise<string> {
  const res = await fetchImpl('https://api.line.me/oauth2/v2.1/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: config.redirectUri,
      client_id: config.channelId,
      client_secret: config.channelSecret,
      code_verifier: codeVerifier,
    }),
  })
  if (!res.ok) throw new LineAuthError('token_exchange_failed', `LINE token endpoint returned ${res.status}`)
  const data = await res.json<{ id_token?: string }>()
  if (!data.id_token) throw new LineAuthError('no_id_token', 'Token response had no id_token (scope missing "openid"?)')
  return data.id_token
}

export interface VerifiedIdentity {
  lineUserId: string
  displayName?: string
  pictureUrl?: string
}

interface VerifyClaims {
  iss: string
  sub: string
  aud: string
  exp: number
  nonce?: string
  name?: string
  picture?: string
}

export async function verifyIdToken(
  config: Pick<LineAuthConfig, 'channelId'>,
  idToken: string,
  expectedNonce: string,
  fetchImpl: Fetcher = fetch
): Promise<VerifiedIdentity> {
  const res = await fetchImpl('https://api.line.me/oauth2/v2.1/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ id_token: idToken, client_id: config.channelId }),
  })
  if (!res.ok) throw new LineAuthError('id_token_invalid', `LINE verify endpoint returned ${res.status}`)
  const claims = await res.json<VerifyClaims>()

  if (claims.iss !== 'https://access.line.me') throw new LineAuthError('bad_issuer')
  if (claims.aud !== config.channelId) throw new LineAuthError('bad_audience')
  if (!claims.exp || claims.exp * 1000 < Date.now()) throw new LineAuthError('expired')
  if (!claims.nonce || claims.nonce !== expectedNonce) throw new LineAuthError('bad_nonce')
  if (!claims.sub) throw new LineAuthError('missing_sub')

  return { lineUserId: claims.sub, displayName: claims.name, pictureUrl: claims.picture }
}
