import { randomToken, sha256Base64Url } from './crypto'

export interface PkcePair {
  verifier: string
  challenge: string
  method: 'S256'
}

/** RFC 7636 PKCE pair. verifier is 43 base64url chars (32 random bytes), within the 43-128 spec range. */
export async function generatePkce(): Promise<PkcePair> {
  const verifier = randomToken(32)
  const challenge = await sha256Base64Url(verifier)
  return { verifier, challenge, method: 'S256' }
}

export function generateState(): string {
  return randomToken(24)
}

export function generateNonce(): string {
  return randomToken(24)
}
