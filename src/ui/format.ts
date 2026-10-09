import type { Usage } from '../../types'

// Number formatters for the sidebar, band and dossier. "—" = not available,
// "?" = should exist but unknown; an unknown value is never shown as 0.

function oneDecimal(x: number): string {
  const r = Math.round(x * 10) / 10
  return Number.isInteger(r) ? String(r) : r.toFixed(1)
}

export function fmtTokens(n: number): string {
  if (!Number.isFinite(n)) return '?'
  const v = Math.max(0, n)
  if (v < 1000) return String(Math.round(v))
  if (v < 9950) return oneDecimal(v / 1000) + 'k'
  if (v < 999_500) return Math.round(v / 1000) + 'k'
  return oneDecimal(v / 1_000_000) + 'M'
}

export function fmtCost(cost: number | null, source: 'reported' | 'estimated' | null, partial: boolean): string {
  if (cost === null || !Number.isFinite(cost)) return '?'
  const c = Math.max(0, cost)
  let amount: string
  if (c === 0) amount = '$0'
  else if (c < 0.01) amount = '<$0.01'
  else if (c < 100) amount = '$' + c.toFixed(2)
  else amount = '$' + Math.round(c)
  if (partial) amount += '+'
  if (source === 'reported') return amount + ' reported'
  if (source === 'estimated') return amount + ' est.'
  return amount
}

export function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—'
  const s = Math.floor(ms / 1000)
  if (s < 60) return '0:' + String(s).padStart(2, '0')
  const m = Math.floor(s / 60)
  if (m < 60) return m + 'm'
  const h = Math.floor(m / 60)
  const rest = m % 60
  return rest === 0 ? h + 'h' : h + 'h ' + rest + 'm'
}

export function cachePct(u: Usage | null): string {
  if (!u) return '—'
  const input = u.uncached + u.cacheRead + u.cacheWrite
  if (!(input > 0)) return '—'
  return Math.round((u.cacheRead / input) * 100) + '%'
}

// Braille dot bits for a column filled from the bottom, height 0..4.
const LEFT_COLUMN = [0x00, 0x40, 0x44, 0x46, 0x47]
const RIGHT_COLUMN = [0x00, 0x80, 0xa0, 0xb0, 0xb8]

/**
 * Braille sparkline: one character per two values (left and right dot column),
 * scaled to the max. A real value always draws at least its bottom dot, so a
 * flat-zero series still reads as a baseline; the newest values are kept when
 * there are more than `2 × width`.
 */
export function sparkline(values: readonly number[], width: number): string {
  const cap = Math.floor(width) * 2
  if (values.length === 0 || !(cap > 0)) return ''
  const tail = values.slice(-cap).map(v => (Number.isFinite(v) && v > 0 ? v : 0))
  const max = Math.max(...tail)
  const heights = tail.map(v => (max > 0 ? Math.max(1, Math.round((v / max) * 4)) : 1))
  // An odd count leaves the oldest slot empty so the newest pair stays whole.
  if (heights.length % 2 === 1) heights.unshift(0)
  let out = ''
  for (let i = 0; i < heights.length; i += 2) {
    out += String.fromCodePoint(0x2800 + LEFT_COLUMN[heights[i] ?? 0]! + RIGHT_COLUMN[heights[i + 1] ?? 0]!)
  }
  return out
}
