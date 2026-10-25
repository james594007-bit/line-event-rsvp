// Mirrors public/escape-html.js (plain global script, no module system, used
// by mod.js/owner.js/mod-apply.js to escape untrusted data — event titles,
// LINE display names, registrant names — before interpolating into
// innerHTML). This TS copy exists so the escaping logic itself can be unit
// tested against real malicious payloads; there's no browser/DOM test
// environment wired up for the plain client-side .js files directly.
export function escapeHtml(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
