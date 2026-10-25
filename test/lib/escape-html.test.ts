import { describe, it, expect } from 'vitest'
import { escapeHtml } from '../../src/lib/escape-html'

describe('escapeHtml', () => {
  it('neutralizes an <img onerror> payload — no raw < or > survives', () => {
    const out = escapeHtml('<img src=x onerror=alert(1)>')
    expect(out).not.toContain('<img')
    expect(out).not.toMatch(/[<>]/)
    expect(out).toBe('&lt;img src=x onerror=alert(1)&gt;')
  })

  it('neutralizes a double-quote attribute breakout + injected <script>', () => {
    const out = escapeHtml('"><script>alert(1)</script>')
    expect(out).not.toMatch(/[<>"]/)
    expect(out).toBe('&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;')
  })

  it('neutralizes a single-quote attribute breakout', () => {
    const out = escapeHtml(`' onmouseover='alert(1)`)
    expect(out).not.toContain("'")
    expect(out).toBe('&#39; onmouseover=&#39;alert(1)')
  })

  it('escapes bare ampersands so output cannot be re-decoded into new entities', () => {
    expect(escapeHtml('Tom & Jerry')).toBe('Tom &amp; Jerry')
  })

  it('leaves ordinary text (including non-ASCII names) unchanged', () => {
    expect(escapeHtml('小明')).toBe('小明')
    expect(escapeHtml('週末北插天山健走')).toBe('週末北插天山健走')
  })

  it('treats null/undefined as empty string instead of the literal text "null"/"undefined"', () => {
    expect(escapeHtml(null)).toBe('')
    expect(escapeHtml(undefined)).toBe('')
  })
})
