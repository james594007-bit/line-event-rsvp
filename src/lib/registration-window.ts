export function parseTaipeiCutoff(value: string | null | undefined): Date | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return null
  const parsed = new Date(`${value}:00+08:00`)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

export function isRegistrationClosed(
  event: { status?: string | null; cutoff_at?: string | null },
  now = new Date()
): boolean {
  if (event.status === 'closed') return true
  const cutoff = parseTaipeiCutoff(event.cutoff_at)
  return cutoff ? cutoff.getTime() <= now.getTime() : false
}

export function isValidTaipeiCutoff(value: unknown): value is string {
  return typeof value === 'string' && parseTaipeiCutoff(value) !== null
}
