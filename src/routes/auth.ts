import { Hono } from 'hono'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'
import type { Bindings } from '../bindings'
import { generatePkce, generateState, generateNonce } from '../lib/pkce'
import { buildAuthorizeUrl, exchangeCodeForIdToken, verifyIdToken, LineAuthError } from '../lib/line-auth'
import { createSession, SESSION_COOKIE_NAME, revokeSession } from '../lib/session'
import { ensureOwnerBootstrap, getModeratorByLineUserId } from '../lib/moderators'
import { checkRateLimit } from '../lib/ratelimit'
import { signPayload, randomToken } from '../lib/crypto'
import { CSRF_COOKIE_NAME, requireAuthenticated } from '../middleware'

const OAUTH_BUNDLE_COOKIE = 'line_oauth'
export const VERIFIED_IDENTITY_COOKIE = 'verified_identity' // short-lived bridge: LINE-verified but not yet an applicant

export const authRoutes = new Hono<{ Bindings: Bindings }>()

function callbackRedirectUri(requestUrl: string): string {
  return new URL('/auth/line/callback', requestUrl).toString()
}

authRoutes.get('/auth/line/start', async (c) => {
  const ip = c.req.header('cf-connecting-ip') ?? 'unknown'
  const rl = await checkRateLimit(c.env.DB, `auth_start:${ip}`, 10, 60)
  if (!rl.allowed) return c.text('嘗試太多次,請稍後再試', 429)

  const state = generateState()
  const nonce = generateNonce()
  const pkce = await generatePkce()

  const bundle = JSON.stringify({ state, nonce, verifier: pkce.verifier })
  setCookie(c, OAUTH_BUNDLE_COOKIE, bundle, {
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    maxAge: 600,
    path: '/',
  })

  const url = buildAuthorizeUrl(
    { channelId: c.env.LINE_LOGIN_CHANNEL_ID, redirectUri: callbackRedirectUri(c.req.url) },
    { state, nonce, codeChallenge: pkce.challenge }
  )
  return c.redirect(url, 302)
})

authRoutes.get('/auth/line/callback', async (c) => {
  const ip = c.req.header('cf-connecting-ip') ?? 'unknown'
  const rl = await checkRateLimit(c.env.DB, `auth_callback:${ip}`, 20, 60)
  if (!rl.allowed) return c.text('嘗試太多次,請稍後再試', 429)

  const bundleRaw = getCookie(c, OAUTH_BUNDLE_COOKIE)
  deleteCookie(c, OAUTH_BUNDLE_COOKIE, { path: '/' })
  if (!bundleRaw) return c.text('登入逾時或重複送出,請重新開始登入', 400)

  let bundle: { state: string; nonce: string; verifier: string }
  try {
    bundle = JSON.parse(bundleRaw)
  } catch {
    return c.text('登入狀態毀損,請重新開始登入', 400)
  }

  const returnedState = c.req.query('state')
  const code = c.req.query('code')
  if (!code || !returnedState || returnedState !== bundle.state) {
    return c.text('登入驗證失敗(state不符,可能是CSRF攻擊或連結過期)', 400)
  }

  const config = {
    channelId: c.env.LINE_LOGIN_CHANNEL_ID,
    channelSecret: c.env.LINE_LOGIN_CHANNEL_SECRET,
    redirectUri: callbackRedirectUri(c.req.url),
  }

  let identity
  try {
    const idToken = await exchangeCodeForIdToken(config, code, bundle.verifier)
    identity = await verifyIdToken(config, idToken, bundle.nonce)
  } catch (err) {
    const code = err instanceof LineAuthError ? err.code : 'unknown'
    return c.text(`登入驗證失敗(${code})`, 400)
  }

  await ensureOwnerBootstrap(c.env.DB, identity.lineUserId, c.env.OWNER_LINE_USER_ID)
  const moderator = await getModeratorByLineUserId(c.env.DB, identity.lineUserId)

  if (moderator) {
    const { token, expiresAt } = await createSession(c.env.DB, moderator.id, moderator.session_version)
    setCookie(c, SESSION_COOKIE_NAME, token, { httpOnly: true, secure: true, sameSite: 'Lax', path: '/', expires: new Date(expiresAt) })
    const csrfToken = randomToken(16)
    setCookie(c, CSRF_COOKIE_NAME, csrfToken, { httpOnly: false, secure: true, sameSite: 'Lax', path: '/', expires: new Date(expiresAt) })
    return c.redirect('/mod', 302)
  }

  // Verified via LINE, but no moderator row exists yet — bridge to the apply
  // step without granting any session/permission (FR-01: login ≠ approval).
  const bridge = await signPayload(
    c.env.COOKIE_SIGNING_SECRET,
    { lineUserId: identity.lineUserId, displayName: identity.displayName },
    600
  )
  setCookie(c, VERIFIED_IDENTITY_COOKIE, bridge, { httpOnly: true, secure: true, sameSite: 'Lax', path: '/', maxAge: 600 })
  return c.redirect('/mod-apply', 302)
})

authRoutes.post('/auth/logout', requireAuthenticated, async (c) => {
  const token = getCookie(c, SESSION_COOKIE_NAME)
  await revokeSession(c.env.DB, token)
  deleteCookie(c, SESSION_COOKIE_NAME, { path: '/' })
  deleteCookie(c, CSRF_COOKIE_NAME, { path: '/' })
  return c.json({ ok: true })
})
