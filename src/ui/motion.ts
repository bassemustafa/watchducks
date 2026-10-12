import { DEFAULT_COLOR, encodeCells, hex, type RasterSpec } from './raster'
import { PALETTE } from './theme'

export type StampKind = 'done' | 'failed' | 'killed'

export const TICK_MS = 600
export const STAMP_MS = 1500
export const BREATH_MS = 1600

const REVEAL_MS = 1000
const BLINK_MS = 150

const SHADES = [0xfbbf24, 0xf59e0b, 0xd97706, 0xb45309] as const
const BREATH_STEPS = [0, 1, 2, 3, 2, 1] as const

export const STAMP_TEXT: Record<StampKind, string> = {
  done: '✦ DEBRIEFED ✦',
  failed: '✕ WENT DARK ✕',
  killed: '✕ BURNED ✕',
}

const STAMP_COLOR: Record<StampKind, number> = {
  done: hex(PALETTE.done),
  failed: hex(PALETTE.failed),
  killed: hex(PALETTE.ended),
}

/** What the terminal pane render and the animation timer hand to each other; never persisted. Reset on every pane render. */
export const motion: {
  /** Run ids of the running-card dots (`dot:<id>`) the last terminal pane render mounted. */
  dots: string[]
  /** Stamps (`stamp:<id>`) the last terminal pane render mounted. */
  stamps: Record<string, { kind: StampKind; startedAt: number }>
  duckMounted: boolean
  /** Per-session duck seed, fnv1a(sessionId). */
  seed: number
} = { dots: [], stamps: {}, duckMounted: false, seed: 0 }

/** The stamp text as one row of cells; characters past `visible` are blank. */
export function stampRaster(runId: string, kind: StampKind, progress: number): RasterSpec {
  const { visible, color } = stampFrame(progress, kind)
  const chars = Array.from(STAMP_TEXT[kind])
  const cells = chars.map((ch, i): [number, number, number] => (i < visible ? [ch.codePointAt(0) ?? 0x20, color, DEFAULT_COLOR] : [0x20, DEFAULT_COLOR, DEFAULT_COLOR]))
  return { key: `stamp:${runId}`, columns: chars.length, rows: 1, cells: encodeCells(cells) }
}

/** The 1×1 status dot of a running card in the given breath color. */
export function dotRaster(runId: string, glyph: string, color: number): RasterSpec {
  return { key: `dot:${runId}`, columns: 1, rows: 1, cells: encodeCells([[glyph.codePointAt(0) ?? 0x20, color, DEFAULT_COLOR]]) }
}

/** Four amber shades, brightest first; one full breath every 1600 ms. */
export function dotFrame(tMs: number): { color: number } {
  const phase = ((tMs % BREATH_MS) + BREATH_MS) % BREATH_MS
  const step = Math.floor((phase / BREATH_MS) * BREATH_STEPS.length)
  return { color: SHADES[BREATH_STEPS[step]!]! }
}

/** Visible characters of the stamp text for progress 0..1 (reveal over the first 1000 ms of a 1500 ms stamp), plus its color. */
export function stampFrame(progress: number, kind: StampKind): { text: string; visible: number; color: number } {
  const text = STAMP_TEXT[kind]
  const total = Array.from(text).length
  const p = Number.isFinite(progress) ? Math.min(1, Math.max(0, progress)) : 0
  const reveal = Math.min(1, (p * STAMP_MS) / REVEAL_MS)
  return { text, visible: Math.min(total, Math.floor(reveal * total + 1e-9)), color: STAMP_COLOR[kind] }
}

function mix(n: number): number {
  let x = n >>> 0
  x = Math.imul(x ^ (x >>> 16), 0x45d2c8b5) >>> 0
  x = Math.imul(x ^ (x >>> 13), 0x2c1b3c6d) >>> 0
  return (x ^ (x >>> 16)) >>> 0
}

/** Gap before blink k, a multiple of 10 ms within 4000..7000. */
function gapBefore(seed: number, k: number): number {
  return 4000 + 10 * (mix(Math.imul(seed | 0, 0x9e3779b1) + k) % 301)
}

const CYCLE_BLINKS = 12
const CYCLE_SEEDS = 8
const cycles = new Map<number, number>()

/** Length of one full 12-blink schedule for the seed; the only thing cached across calls. */
function cycleOf(seed: number): number {
  const hit = cycles.get(seed)
  if (hit !== undefined) return hit
  let sum = 0
  for (let k = 0; k < CYCLE_BLINKS; k++) sum += gapBefore(seed, k)
  if (cycles.size >= CYCLE_SEEDS) cycles.delete(cycles.keys().next().value as number)
  cycles.set(seed, sum)
  return sum
}

function blinkPose(seed: number, k: number): 'blink' | 'glanceLeft' | 'glanceRight' {
  if (k % 3 !== 2) return 'blink'
  return mix(Math.imul(seed | 0, 0x85ebca6b) + k) % 2 === 0 ? 'glanceLeft' : 'glanceRight'
}

/**
 * The duck pose at time t for a deterministic per-session seed: blink 150 ms every 4000–7000 ms, a glance on every third blink.
 * The schedule repeats every 12 blinks; the last blink of a cycle sits at the cycle boundary, so at most 12 steps are walked.
 */
export function duckFrame(tMs: number, seed: number): 'open' | 'blink' | 'glanceLeft' | 'glanceRight' {
  if (!Number.isFinite(tMs) || tMs < 0) return 'open'
  const cycle = cycleOf(seed)
  const t = tMs % cycle
  if (t < BLINK_MS) return blinkPose(seed, CYCLE_BLINKS - 1)
  let start = 0
  for (let k = 0; k < CYCLE_BLINKS - 1; k++) {
    start += gapBefore(seed, k)
    if (t < start) return 'open'
    if (t < start + BLINK_MS) return blinkPose(seed, k)
  }
  return 'open'
}

/**
 * The pose to draw on an animation tick `tickMs` long: a blink shorter than a tick could fall between two ticks,
 * so the pose half a tick earlier is checked too and any non-open pose wins.
 */
export function duckPoseAt(nowMs: number, seed: number, tickMs: number): ReturnType<typeof duckFrame> {
  const pose = duckFrame(nowMs, seed)
  return pose !== 'open' ? pose : duckFrame(nowMs - tickMs / 2, seed)
}

/** Ease-out interpolation from `from` to `to`, p clamped to 0..1, rounded to an integer. */
export function tween(from: number, to: number, p: number): number {
  const c = Number.isFinite(p) ? Math.min(1, Math.max(0, p)) : 0
  const e = 1 - (1 - c) ** 3
  return Math.round(from + (to - from) * e)
}
