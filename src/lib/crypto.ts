export function toBase64Url(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  let binary = ''
  for (const b of arr) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function toHex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** Cryptographically random, URL-safe string. Used for state, nonce, PKCE verifier, and session tokens. */
export function randomToken(byteLength = 32): string {
  const bytes = new Uint8Array(byteLength)
  crypto.getRandomValues(bytes)
  return toBase64Url(bytes)
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))
  return toHex(digest)
}

export async function sha256Base64Url(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))
  return toBase64Url(digest)
}

/** Constant-time string comparison, for comparing secrets/hashes. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
}

export async function hmacSign(secret: string, value: string): Promise<string> {
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), new TextEncoder().encode(value))
  return toBase64Url(sig)
}

/**
 * Signs a short-lived JSON payload for use as a cookie value (e.g. bridging
 * "verified via LINE OAuth" to "submitted moderator application" without a
 * DB row in between). Format: `${base64url(json)}.${base64url(hmac)}`.
 */
export async function signPayload(secret: string, payload: unknown, ttlSeconds: number): Promise<string> {
  const body = JSON.stringify({ ...((payload as object) ?? {}), exp: Math.floor(Date.now() / 1000) + ttlSeconds })
  const encoded = toBase64Url(new TextEncoder().encode(body))
  const sig = await hmacSign(secret, encoded)
  return `${encoded}.${sig}`
}

export async function verifyPayload<T>(secret: string, cookieValue: string | undefined): Promise<T | null> {
  if (!cookieValue) return null
  const [encoded, sig] = cookieValue.split('.')
  if (!encoded || !sig) return null
  const expectedSig = await hmacSign(secret, encoded)
  if (!timingSafeEqual(expectedSig, sig)) return null
  try {
    const padded = encoded.replace(/-/g, '+').replace(/_/g, '/')
    const binary = atob(padded.padEnd(padded.length + ((4 - (padded.length % 4)) % 4), '='))
    const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0))
    const json = new TextDecoder().decode(bytes) // atob gives Latin1 bytes, not UTF-8 text — decode properly for non-ASCII (e.g. Chinese display names)
    const payload = JSON.parse(json) as T & { exp: number }
    if (!payload.exp || payload.exp * 1000 < Date.now()) return null
    return payload
  } catch {
    return null
  }
}
