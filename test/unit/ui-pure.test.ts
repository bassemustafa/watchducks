import { expect, test } from 'claude-code/testing'

import { cachePct, fmtCost, fmtDuration, fmtTokens, sparkline } from '../../src/ui/format'
import { DEFAULT_COLOR, dimTwin, duckLogo, encodeCells, gradientBar, hex, radarFrame, type RasterSpec } from '../../src/ui/raster'
import { barSvg, headerSvg } from '../../src/ui/svg'
import { glyphs, statusColor, statusWords } from '../../src/ui/theme'

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

// Decodes standard base64 into bytes (no Buffer or atob: the test runs in the hooks environment).
function bytesOf(b64: string): number[] {
  const out: number[] = []
  let buf = 0
  let bits = 0
  for (const ch of b64.replace(/=+$/, '')) {
    buf = ((buf << 6) | B64.indexOf(ch)) & 0xffffff
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out.push((buf >> bits) & 0xff)
    }
  }
  return out
}

// Each cell is three little-endian u32 values: code point, foreground, background.
function cellsOf(spec: RasterSpec): number[][] {
  const b = bytesOf(spec.cells)
  const cells: number[][] = []
  for (let i = 0; i < b.length; i += 12) {
    cells.push([0, 4, 8].map(o => (b[i + o]! | (b[i + o + 1]! << 8) | (b[i + o + 2]! << 16) | (b[i + o + 3]! << 24)) >>> 0))
  }
  return cells
}

test('encodeCells writes little-endian u32 triplets as padded base64', () => {
  expect(encodeCells([[0x2588, 0xff8800, 0x01000000]])).toBe('iCUAAACI/wAAAAAB')
})

test('duckLogo is 12 by 6 cells', () => {
  const logo = duckLogo()
  expect(logo.columns).toBe(12)
  expect(logo.rows).toBe(6)
  expect(cellsOf(logo).length).toBe(72)
})

test('radarFrame for ticks 0 to 23 is 20 by 9 with width-1 code points', () => {
  const blips = [{ angle: 0.5, radius: 0.6, color: 0xfbbf24, pulse: true }]
  for (let tick = 0; tick < 24; tick++) {
    const f = radarFrame(tick, blips, 20, 9)
    expect(f.key).toBe('radar')
    expect(f.columns).toBe(20)
    expect(f.rows).toBe(9)
    const cells = cellsOf(f)
    expect(cells.length).toBe(180)
    for (const [cp] of cells) expect(cp! >= 0x20 && cp! <= 0xfffe).toBe(true)
  }
})

test('gradientBar at 0.5 over 10 columns has five filled cells', () => {
  const bar = gradientBar(0.5, 10, 0x2dd4bf, 0x34d399, 'bar')
  expect(bar.rows).toBe(1)
  expect(cellsOf(bar).filter(([cp]) => cp === 0x2588).length).toBe(5)
})

test('headerSvg has no script or on* attributes and animates only when motion is on', () => {
  const opts = { blips: [{ angle: 1, radius: 0.5, status: 'running' as const }], width: 400 }
  const on = headerSvg({ ...opts, motion: true })
  const off = headerSvg({ ...opts, motion: false })
  for (const svg of [on, off]) {
    expect(svg).not.toContain('<script')
    expect(/\son[a-z]+=/i.test(svg)).toBe(false)
  }
  expect(on).toContain('animateTransform')
  expect(off).not.toContain('animateTransform')
})

test('barSvg escapes labels', () => {
  const svg = barSvg([{ label: '<b>', value: 1, color: '#2dd4bf' }], 200)
  expect(svg).not.toContain('<b>')
  expect(svg).toContain('&lt;b&gt;')
})

test('fmtTokens scales to k and M', () => {
  expect(fmtTokens(999)).toBe('999')
  expect(fmtTokens(1234)).toBe('1.2k')
  expect(fmtTokens(412000)).toBe('412k')
  expect(fmtTokens(1250000)).toBe('1.3M')
})

test('fmtCost covers unknown cost, reported zero, estimate and partial', () => {
  expect(fmtCost(null, null, false)).toBe('?')
  expect(fmtCost(0, 'reported', false)).toBe('$0 reported')
  expect(fmtCost(1.8432, 'estimated', false)).toBe('$1.84 est.')
  expect(fmtCost(1.8432, 'estimated', true)).toContain('+')
})

test('fmtDuration', () => {
  expect(fmtDuration(41000)).toBe('0:41')
  expect(fmtDuration(420000)).toBe('7m')
  expect(fmtDuration(3_900_000)).toBe('1h 5m')
})

test('cachePct is a dash without input, else the rounded cache-read share', () => {
  expect(cachePct(null)).toBe('—')
  expect(cachePct({ uncached: 0, output: 0, cacheRead: 0, cacheWrite: 0 })).toBe('—')
  expect(cachePct({ uncached: 39, output: 0, cacheRead: 61, cacheWrite: 0 })).toBe('61%')
})

test('sparkline is empty for no values and one braille char per two values', () => {
  expect(sparkline([], 10)).toBe('')
  expect(sparkline([1, 2, 3, 4], 10).length).toBe(2)
})

test('statusWords for ended', () => {
  expect(statusWords('ended')).toEqual({ spy: 'RETURNED', plain: 'outcome unknown' })
})

// ---- additions beyond the plan: design properties and edge cases

function pairsOf(spec: RasterSpec): number {
  return new Set(cellsOf(spec).map(([, fg, bg]) => fg + ':' + bg)).size
}

test('sparkline keeps the newest values, scales to the max and keeps a baseline', () => {
  expect(sparkline([0, 0, 0, 0], 5)).toBe('⣀⣀')
  expect(sparkline([1, 2, 3, 4, 5, 6], 2).length).toBe(2)
  expect(sparkline([0, 4], 1)).toBe(String.fromCodePoint(0x28f8))
  expect(sparkline([3], 5).length).toBe(1)
})

test('fmtTokens, fmtCost and fmtDuration edge cases', () => {
  expect(fmtTokens(0)).toBe('0')
  expect(fmtTokens(1000)).toBe('1k')
  expect(fmtTokens(9949)).toBe('9.9k')
  expect(fmtTokens(999_600)).toBe('1M')
  expect(fmtCost(0.004, 'estimated', false)).toBe('<$0.01 est.')
  expect(fmtCost(1.8432, 'reported', true)).toBe('$1.84+ reported')
  expect(fmtCost(12, null, false)).toBe('$12.00')
  expect(fmtDuration(0)).toBe('0:00')
  expect(fmtDuration(3_600_000)).toBe('1h')
  expect(fmtDuration(-1)).toBe('—')
})

test('hex and dimTwin', () => {
  expect(hex('#2dd4bf')).toBe(0x2dd4bf)
  expect(hex('#fff')).toBe(0xffffff)
  expect(hex('teal')).toBe(DEFAULT_COLOR)
  expect(dimTwin(0xfbbf24)).toBe(0xb45309)
  expect(dimTwin(0x34d399)).toBeLessThan(0x34d399)
})

test('theme glyphs and colors', () => {
  expect(glyphs('emoji').duck).toBe('🦆')
  expect(glyphs('emoji').dot.running).toBe('●')
  expect(glyphs('ascii').duck).toBe('>o)')
  expect(glyphs('ascii').dot.killed).toBe('x')
  expect(statusColor('running')).toBe('#fbbf24')
  expect(statusColor('unknown')).toBe('#64748b')
  expect(statusWords('running')).toEqual({ spy: 'IN FIELD', plain: 'running' })
})

test('duckLogo wears a teal band, dark glasses and a hat, and stays under the color-pair budget', () => {
  const logo = duckLogo()
  const cells = cellsOf(logo)
  const at = (col: number, row: number) => cells[row * 12 + col]!
  // Hat band: the lower pixel of cell row 1 is teal under the crown.
  expect(at(5, 1)[2]).toBe(0x2dd4bf)
  // Glasses: cell row 3 has near-black pixels, with a glint.
  expect(cells.slice(36, 48).some(([, fg]) => fg === 0x020617)).toBe(true)
  expect(cells.slice(36, 48).some(([, fg]) => fg === 0x7dd3fc)).toBe(true)
  // Corners above the hat are transparent; the brim row reaches the edge.
  expect(at(0, 0)[0]).toBe(0x20)
  expect(at(0, 2)[0]).toBe(0x2580)
  expect(pairsOf(logo)).toBeLessThan(1024)
  expect(cells.every(([cp]) => cp === 0x20 || cp === 0x2580 || cp === 0x2584 || cp === 0x2588)).toBe(true)
})

test('radar sweep: the leading edge is the brightest color, moves each tick and wraps at 24', () => {
  const brightest = (tick: number) => cellsOf(radarFrame(tick, [], 20, 9)).filter(([, fg]) => fg === 0x99f6e4).length
  for (let t = 0; t < 24; t++) expect(brightest(t)).toBeGreaterThan(0)
  expect(radarFrame(0, [], 20, 9).cells).not.toBe(radarFrame(6, [], 20, 9).cells)
  expect(radarFrame(0, [], 20, 9).cells).toBe(radarFrame(24, [], 20, 9).cells)
  expect(radarFrame(-24, [], 20, 9).cells).toBe(radarFrame(0, [], 20, 9).cells)
  // Four trailing steps fade: every fade color shows up behind the edge.
  const colors = new Set(cellsOf(radarFrame(0, [], 20, 9)).map(([, fg]) => fg))
  for (const c of [0x99f6e4, 0x2dd4bf, 0x14b8a6, 0x0f766e, 0x115e59, 0x475569]) expect(colors.has(c)).toBe(true)
  expect(pairsOf(radarFrame(5, [], 20, 9))).toBeLessThan(32)
})

test('radar blips are bullets that pulse with tick parity', () => {
  const blips = [{ angle: 0, radius: 0.5, color: 0xfbbf24, pulse: true }]
  const bullet = (tick: number) => cellsOf(radarFrame(tick, blips, 20, 9)).filter(([cp]) => cp === 0x2022)
  expect(bullet(0).length).toBe(1)
  expect(bullet(0)[0]![1]).toBe(0xfbbf24)
  expect(bullet(1)[0]![1]).toBe(0xb45309)
  expect(bullet(2)[0]![1]).toBe(0xfbbf24)
  // angle 0 = east of the center, so the bullet sits right of the middle column on the middle row.
  const idx = cellsOf(radarFrame(0, blips, 20, 9)).findIndex(([cp]) => cp === 0x2022)
  expect(idx % 20).toBeGreaterThan(10)
  expect(Math.floor(idx / 20)).toBe(4)
  const still = [{ angle: 0, radius: 0.5, color: 0x34d399, pulse: false }]
  expect(cellsOf(radarFrame(1, still, 20, 9)).filter(([cp]) => cp === 0x2022)[0]![1]).toBe(0x34d399)
})

test('radarFrame clamps its size and survives odd blips', () => {
  const f = radarFrame(3, [{ angle: Number.NaN, radius: 7, color: 0x34d399, pulse: false }], 0, 1000)
  expect(f.columns).toBe(1)
  expect(f.rows).toBe(256)
  expect(cellsOf(f).length).toBe(256)
})

test('gradientBar interpolates from to, fills the rest with a dim light shade and clamps', () => {
  const cells = cellsOf(gradientBar(0.5, 10, 0x000000, 0xff0000, 'g'))
  expect(cells[0]![1]).toBe(0x000000)
  expect(cells[4]![1]).toBe(0xff0000)
  expect(cells[5]![0]).toBe(0x2591)
  expect(cellsOf(gradientBar(2, 4, 0, 0, 'g')).every(([cp]) => cp === 0x2588)).toBe(true)
  expect(cellsOf(gradientBar(-1, 4, 0, 0, 'g')).every(([cp]) => cp === 0x2591)).toBe(true)
  expect(gradientBar(1, 600, 0, 0xffffff, 'wide').columns).toBe(512)
  expect(pairsOf(gradientBar(1, 512, 0, 0xffffff, 'wide'))).toBeLessThan(1024)
})

test('headerSvg is a bounded, themed, glowing document', () => {
  const blips = (['running', 'done', 'failed', 'killed', 'ended', 'unknown'] as const).map((status, i) => ({ angle: i, radius: 0.2 + i / 10, status }))
  const svg = headerSvg({ blips, motion: true, width: 400 })
  expect(svg).toStartWith('<svg ')
  expect(svg).toEndWith('</svg>')
  expect(svg.length).toBeLessThan(131072)
  expect(svg).toContain('prefers-color-scheme: light')
  expect(svg).toContain('#f8fafc')
  expect(svg).toContain('feGaussianBlur')
  expect(svg).toContain('rx="14"')
  expect(svg).toContain('dur="4s"')
  expect(svg).toContain('repeatCount="indefinite"')
  expect(svg).toContain('THE FLOCK')
  expect(svg).toContain('1 IN FIELD')
  expect(svg).toContain('6 TRACKED')
  expect(headerSvg({ blips: [], motion: false, width: 400 })).toContain('STANDING BY')
  const off = headerSvg({ blips, motion: false, width: 400 })
  expect(off).not.toContain('<animate')
  expect(off).not.toContain('repeatCount')
  expect(headerSvg({ blips, motion: true, width: 400 })).toBe(svg)
  const many = Array.from({ length: 500 }, (_, i) => ({ angle: i, radius: 0.5, status: 'running' as const }))
  expect(headerSvg({ blips: many, motion: true, width: 1200 }).length).toBeLessThan(131072)
  expect(headerSvg({ blips: [], motion: false, width: 10 })).toContain('width="280"')
})

test('barSvg draws a segment per positive value with exact tooltips and safe colors', () => {
  const svg = barSvg(
    [
      { label: 'codex & co', value: 3, color: '#2dd4bf' },
      { label: 'zero', value: 0, color: '#f87171' },
      { label: "o'pencode", value: 1, color: 'url(javascript:x)' },
    ],
    200,
  )
  expect(svg).toContain('<title>codex &amp; co: 3 (75%)</title>')
  expect(svg).toContain('<title>o&#39;pencode: 1 (25%)</title>')
  expect(svg).not.toContain('zero')
  expect(svg).not.toContain('javascript')
  expect(svg).toContain('#64748b')
  expect(svg).toContain('linearGradient')
  expect(/\son[a-z]+=/i.test(svg)).toBe(false)
  const empty = barSvg([], 200)
  expect(empty).not.toContain('<title>')
  expect(empty).toContain('width="200"')
})
