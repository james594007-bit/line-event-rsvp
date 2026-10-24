// Minimal, self-contained request throttling backed by D1.
//
// Not relying on Cloudflare's zone-level Rate Limiting Rules: this Worker is
// served from the shared *.workers.dev domain, not a zone James manages, so
// zone-level WAF/Rate Limiting Rules may not even be configurable for it
// regardless of plan tier — that's a dashboard/account question outside what
// this branch can verify or configure. A Worker-native "ratelimit" binding
// also exists on newer wrangler/Workers builds, but pinning this feature to
// that binding would make correctness depend on exact platform/version
// support we can't confirm without deploying. This D1-backed limiter works
// everywhere the Worker already runs and is fully testable locally; it can
// be layered with platform-level limiting later as defense-in-depth.

export interface RateLimitResult {
  allowed: boolean
  remaining: number
  resetAt: number // unix seconds
}

/**
 * Fixed-window counter. `key` should already identify the caller + route,
 * e.g. `login:${ip}` or `apply:${lineUserId}`.
 */
export async function checkRateLimit(
  db: D1Database,
  key: string,
  limit: number,
  windowSeconds: number,
  now: number = Math.floor(Date.now() / 1000)
): Promise<RateLimitResult> {
  const windowStart = Math.floor(now / windowSeconds) * windowSeconds
  const bucketKey = `${key}:${windowStart}`

  const row = await db
    .prepare(
      `INSERT INTO rate_limit_counters (bucket_key, window_start, count) VALUES (?, ?, 1)
       ON CONFLICT(bucket_key) DO UPDATE SET count = count + 1
       RETURNING count`
    )
    .bind(bucketKey, windowStart)
    .first<{ count: number }>()

  const count = row?.count ?? 1
  // Opportunistic cleanup of expired windows so the table doesn't grow unbounded.
  // Cheap relative to the write above; fine to run on every call at this traffic scale.
  await db.prepare('DELETE FROM rate_limit_counters WHERE window_start < ?').bind(windowStart - windowSeconds).run()

  return {
    allowed: count <= limit,
    remaining: Math.max(0, limit - count),
    resetAt: windowStart + windowSeconds,
  }
}
