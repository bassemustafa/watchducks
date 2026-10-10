import type { Ledger, Run, RunStatus } from '../../types'
import { fnv1a } from '../codename'
import { hex } from './raster'
import { statusColor } from './theme'

// Pure animation helpers (spec §9.4): where a run's blip sits on the radar and
// the little bit of module-scope state the sidebar render and the timer in
// src/lifecycle.ts share. Nothing here takes `$`: the timers and the blit call
// live beside their hooks, because `$` cannot cross an import.

export type Blip = { angle: number; radius: number; color: number; pulse: boolean }
export type SvgBlip = { angle: number; radius: number; status: RunStatus }

const MAX_BLIPS = 64
const TAU = Math.PI * 2

/** Radar size per width tier: full 20×9, small 16×7. */
export const RADAR_FULL = { columns: 20, rows: 9 } as const
export const RADAR_SMALL = { columns: 16, rows: 7 } as const

/** What the render hook and the timers hand to each other; never persisted. */
export const radar: {
  /** Frame counter of the animation; the render draws the current frame. */
  tick: number
  /** Size of the radar Raster the last pane render mounted; null when none is on screen. */
  mounted: { columns: number; rows: number } | null
  /** Last `viewport.isFullscreen` any render saw. */
  fullscreen: boolean
  /** Blips of the running operatives, refreshed by the watch timer. */
  blips: Blip[]
} = { tick: 0, mounted: null, fullscreen: false, blips: [] }

function position(id: string): { angle: number; radius: number } {
  return {
    angle: ((fnv1a(id) % 360) / 360) * TAU,
    radius: 0.35 + (fnv1a(id + '|r') % 60) / 100,
  }
}

function runsOf(ledger: Ledger): Run[] {
  const runs: Run[] = []
  for (const id of ledger.order) {
    const run = Object.hasOwn(ledger.runs, id) ? ledger.runs[id] : undefined
    if (run) runs.push(run)
  }
  return runs
}

/** One pulsing blip per running operative, colored by status. */
export function blipsFor(ledger: Ledger): Blip[] {
  return runsOf(ledger)
    .filter(run => run.status === 'running')
    .slice(-MAX_BLIPS)
    .map(run => ({ ...position(run.id), color: hex(statusColor(run.status)), pulse: true }))
}

/** One blip per tracked run for the desktop header (the running ones animate there). */
export function svgBlipsFor(ledger: Ledger): SvgBlip[] {
  return runsOf(ledger)
    .slice(-MAX_BLIPS)
    .map(run => ({ ...position(run.id), status: run.status }))
}
