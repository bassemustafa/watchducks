// Terminal pixel art (spec §9.4): cell grids for the `Raster` element. Each cell
// is [code point, foreground, background]; colors are 0x00RRGGBB or DEFAULT_COLOR.
// Everything here is deterministic: the same inputs give the same bytes.

export type RasterSpec = { key: string; columns: number; rows: number; cells: string }

type Cell = readonly [number, number, number]

export const DEFAULT_COLOR = 0x01000000 as const

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/** Little-endian u32 triplets as standard padded base64, with our own encoder. */
export function encodeCells(cells: ReadonlyArray<readonly [number, number, number]>): string {
  const bytes: number[] = []
  for (const cell of cells) {
    for (const value of cell) {
      const u = value >>> 0
      bytes.push(u & 0xff, (u >>> 8) & 0xff, (u >>> 16) & 0xff, (u >>> 24) & 0xff)
    }
  }
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]!
    const b1 = bytes[i + 1]
    const b2 = bytes[i + 2]
    const n = (b0 << 16) | ((b1 ?? 0) << 8) | (b2 ?? 0)
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]!
    out += b1 === undefined ? '=' : B64[(n >> 6) & 63]!
    out += b2 === undefined ? '=' : B64[n & 63]!
  }
  return out
}

/** '#2dd4bf' → 0x2dd4bf; '#fff' works too; anything else is the terminal default. */
export function hex(color: string): number {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color)
  if (!m) return DEFAULT_COLOR
  let h = m[1]!
  if (h.length === 3) h = h[0]! + h[0]! + h[1]! + h[1]! + h[2]! + h[2]!
  return parseInt(h, 16)
}

/** Linear blend of two 0xRRGGBB colors, t in [0, 1]. */
export function mix(a: number, b: number, t: number): number {
  const k = Math.min(1, Math.max(0, t))
  let out = 0
  for (const shift of [16, 8, 0]) {
    const ca = (a >> shift) & 0xff
    const cb = (b >> shift) & 0xff
    out |= Math.round(ca + (cb - ca) * k) << shift
  }
  return out
}

const BG = 0x0f172a
const RUNNING = 0xfbbf24
const RUNNING_DIM = 0xb45309

/** The dim twin a pulsing blip alternates with: amber ↔ burnt amber, else faded toward the background. */
export function dimTwin(color: number): number {
  return color === RUNNING ? RUNNING_DIM : mix(color, BG, 0.55)
}

function toSpec(key: string, columns: number, rows: number, cells: Cell[]): RasterSpec {
  return { key, columns, rows, cells: encodeCells(cells) }
}

function clampInt(n: number, lo: number, hi: number): number {
  const v = Number.isFinite(n) ? Math.floor(n) : lo
  return Math.min(hi, Math.max(lo, v))
}

// ---------------------------------------------------------------- duck logo

// A duck in a fedora and dark glasses, 12×12 pixels = 12×6 cells (two pixels
// per cell: ▀▄█ with foreground and background). One letter per pixel.
const DUCK_ROWS = [
  '...HHDDHH...', //  crown, pinched
  '..HHHHHHHH..',
  '..HHHHHHHH..',
  '..TTTTTTTT..', //  teal hat band
  'BBBBBBBBBBBB', //  brim
  '..YYYYYYYY..', //  forehead
  '.GGWGGGGWGG.', //  glasses, with glints
  '.YGGGYYGGGY.',
  '..YOOOOOOY..', //  bill
  '..YYPPPPYY..',
  '...YYYYYY...', //  neck
  '.SSSSSSSSSS.', //  suit
] as const

const DUCK_COLORS: Record<string, number> = {
  H: 0x64748b,
  D: 0x475569,
  B: 0x94a3b8,
  T: 0x2dd4bf,
  Y: 0xfbbf24,
  O: 0xfb923c,
  P: 0xea580c,
  G: 0x020617,
  W: 0x7dd3fc,
  S: 0x475569,
}

/** The duck as a grid of 0xRRGGBB colors (null = transparent), rows top to bottom. */
export function duckPixels(): Array<Array<number | null>> {
  return DUCK_ROWS.map(row => Array.from(row, ch => DUCK_COLORS[ch] ?? null))
}

function halfBlock(top: number | null, bottom: number | null): Cell {
  if (top === null && bottom === null) return [0x20, DEFAULT_COLOR, DEFAULT_COLOR]
  if (bottom === null) return [0x2580, top!, DEFAULT_COLOR]
  if (top === null) return [0x2584, bottom, DEFAULT_COLOR]
  if (top === bottom) return [0x2588, top, DEFAULT_COLOR]
  return [0x2580, top, bottom]
}

export function duckLogo(): RasterSpec {
  const px = duckPixels()
  const cells: Cell[] = []
  for (let r = 0; r < 6; r++) {
    for (let c = 0; c < 12; c++) {
      cells.push(halfBlock(px[2 * r]![c] ?? null, px[2 * r + 1]![c] ?? null))
    }
  }
  return toSpec('duck', 12, 6, cells)
}

// -------------------------------------------------------------------- radar

const TAU = Math.PI * 2
const STEP = TAU / 24
const TRAIL_STEPS = 4

// Foreground per brightness class: faint range rings, outer ring, four fading
// trail steps (oldest first), then the bright leading edge.
const CLASS_COLORS = [DEFAULT_COLOR, 0x334155, 0x475569, 0x115e59, 0x0f766e, 0x14b8a6, 0x2dd4bf, 0x99f6e4] as const
const FAINT = 1
const RING = 2
const TRAIL_BASE = 2 // trail step k (1 = newest) has class TRAIL_BASE + TRAIL_STEPS + 1 - k
const LEAD = 7

// Braille bit for a dot at column dx (0..1), row dy (0..3).
const DOT_BITS = [
  [0x01, 0x02, 0x04, 0x40],
  [0x08, 0x10, 0x20, 0x80],
] as const

function trailKept(step: number, ix: number, iy: number): boolean {
  if (step === 1) return true
  if (step === 2) return (ix + iy) % 2 === 0
  if (step === 3) return ix % 2 === 0 && iy % 2 === 0
  return ix % 2 === 0 && iy % 2 === 0 && (ix + iy) % 4 === 0
}

/**
 * One radar frame drawn in braille dots (2×4 per cell, square dots): faint
 * range rings, an outer ring, a sweep whose bright leading edge sits at angle
 * `tick × 2π/24` (0 = east, clockwise) with four fading trailing steps, and
 * each blip as '•' at its angle (same convention) and radius (0..1).
 */
export function radarFrame(
  tick: number,
  blips: ReadonlyArray<{ angle: number; radius: number; color: number; pulse: boolean }>,
  columns: number,
  rows: number,
): RasterSpec {
  const cols = clampInt(columns, 1, 512)
  const rws = clampInt(rows, 1, 256)
  const w = cols * 2
  const h = rws * 4
  const radius = Math.min(w, h) / 2 - 0.75
  const sweep = ((Math.floor(tick) % 24) + 24) % 24 * STEP

  const cells: Cell[] = []
  for (let cy = 0; cy < rws; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      let bits = 0
      let cls = 0
      for (let dx = 0; dx < 2; dx++) {
        for (let dy = 0; dy < 4; dy++) {
          const ix = cx * 2 + dx
          const iy = cy * 4 + dy
          const x = ix + 0.5 - w / 2
          const y = iy + 0.5 - h / 2
          const d = Math.hypot(x, y)
          let c = 0
          if (d <= radius + 0.5) {
            const delta = (((sweep - Math.atan2(y, x)) % TAU) + TAU) % TAU
            if (delta < Math.PI / 2 && d * Math.sin(delta) < 0.7) {
              c = LEAD
            } else if (d <= radius - 0.5 && delta < TRAIL_STEPS * STEP) {
              const step = Math.ceil(delta / STEP)
              if (trailKept(step, ix, iy)) c = TRAIL_BASE + TRAIL_STEPS + 1 - step
            }
            if (c === 0 && Math.abs(d - radius) < 0.6) c = RING
            if (c === 0 && (ix + iy) % 2 === 0 && (Math.abs(d - radius / 3) < 0.55 || Math.abs(d - (radius * 2) / 3) < 0.55)) c = FAINT
          }
          if (c > 0) {
            bits |= DOT_BITS[dx]![dy]!
            if (c > cls) cls = c
          }
        }
      }
      cells.push(bits === 0 ? [0x20, DEFAULT_COLOR, DEFAULT_COLOR] : [0x2800 + bits, CLASS_COLORS[cls]!, DEFAULT_COLOR])
    }
  }

  const reach = radius - 1
  for (const blip of blips) {
    const r = Math.min(1, Math.max(0, Number.isFinite(blip.radius) ? blip.radius : 0))
    const x = w / 2 + Math.cos(blip.angle) * r * reach
    const y = h / 2 + Math.sin(blip.angle) * r * reach
    const bx = clampInt(x / 2, 0, cols - 1)
    const by = clampInt(y / 4, 0, rws - 1)
    const color = blip.pulse && tick % 2 !== 0 ? dimTwin(blip.color) : blip.color
    cells[by * cols + bx] = [0x2022, color, DEFAULT_COLOR]
  }
  return toSpec('radar', cols, rws, cells)
}

// ------------------------------------------------------------- gradient bar

const TRACK = 0x475569
const GRADIENT_LEVELS = 24

/** One row: `fraction` of `width` cells filled with '█' blending from→to, the rest '░' in dim. */
export function gradientBar(fraction: number, width: number, from: number, to: number, key: string): RasterSpec {
  const cols = clampInt(width, 1, 512)
  const f = Number.isFinite(fraction) ? Math.min(1, Math.max(0, fraction)) : 0
  const filled = Math.round(f * cols)
  const cells: Cell[] = []
  for (let i = 0; i < cols; i++) {
    if (i < filled) {
      // Quantised so a wide bar stays far below the 1024 color-pair budget.
      const t = filled > 1 ? Math.round((i / (filled - 1)) * GRADIENT_LEVELS) / GRADIENT_LEVELS : 0
      cells.push([0x2588, mix(from, to, t), DEFAULT_COLOR])
    } else {
      cells.push([0x2591, TRACK, DEFAULT_COLOR])
    }
  }
  return toSpec(key, cols, 1, cells)
}
