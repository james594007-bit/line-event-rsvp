export function eventIdFromSearch(search: string): string | null {
  const params = new URLSearchParams(search)
  const directEventId = params.get('event')
  if (directEventId) return directEventId

  const liffState = params.get('liff.state') ?? ''
  const stateQuery = liffState.includes('?') ? liffState.slice(liffState.indexOf('?') + 1) : liffState
  return new URLSearchParams(stateQuery).get('event')
}

export function eventPreviewDescription(event: {
  eventDate?: string | null
  meetingLocation?: string | null
  capacity?: number | null
}): string {
  const details = [
    event.eventDate ? `日期：${event.eventDate}` : null,
    event.meetingLocation ? `地點：${event.meetingLocation}` : null,
    event.capacity ? `限${event.capacity}人` : null,
  ].filter(Boolean)

  return details.join(' · ') || '點開查看活動資訊與目前報名人數'
}
