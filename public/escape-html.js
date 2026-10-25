// Shared by mod.js / owner.js / mod-apply.js. Loaded as a plain global
// script (not a module) so those files can keep calling escapeHtml() without
// an import. Logic mirrored in src/lib/escape-html.ts and unit-tested there —
// this file has no DOM test environment wired up, so keep the two in sync if
// you change either (both are ~6 lines, low drift risk).
function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
