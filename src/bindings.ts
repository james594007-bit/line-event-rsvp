export type Bindings = {
  DB: D1Database
  ASSETS: Fetcher

  // legacy single-passcode admin (pre owner-access; kept until the stage 5
  // cutover removes it — see docs/OWNER-ACCESS-TECH-ASSESSMENT.md §5)
  ADMIN_PASSCODE: string

  // participant-facing LIFF (unaffected by this work)
  LIFF_ID: string

  // dormant Messaging API push-message code path (still unused in prod)
  LINE_CHANNEL_ACCESS_TOKEN: string
  LINE_CHANNEL_SECRET: string

  // owner/moderator LINE Login OAuth — NEW secrets needed before this can
  // run against the real LINE channel (see final report)
  LINE_LOGIN_CHANNEL_ID: string
  LINE_LOGIN_CHANNEL_SECRET: string
  OWNER_LINE_USER_ID: string
  COOKIE_SIGNING_SECRET: string
}
