import type { RunStatus } from '../../types'

// Night-ops palette (spec §9.4) and the status vocabulary (spec §9.1). Pure data.

export const PALETTE = {
  bg: '#0f172a',
  panel: '#1e293b',
  text: '#e2e8f0',
  dim: '#94a3b8',
  accent: '#2dd4bf',
  running: '#fbbf24',
  runningDim: '#b45309',
  done: '#34d399',
  failed: '#f87171',
  killed: '#fb7185',
  ended: '#64748b',
  handler: '#22d3ee',
} as const

/** The desktop SVG's light scheme; status colors stay as in PALETTE. */
export const LIGHT = {
  bg: '#f8fafc',
  panel: '#e2e8f0',
  text: '#0f172a',
  dim: '#475569',
} as const

const WORDS: Record<RunStatus, { spy: string; plain: string }> = {
  running: { spy: 'IN FIELD', plain: 'running' },
  done: { spy: 'DEBRIEFED', plain: 'done' },
  failed: { spy: 'WENT DARK', plain: 'failed' },
  killed: { spy: 'BURNED', plain: 'stopped' },
  ended: { spy: 'RETURNED', plain: 'outcome unknown' },
  unknown: { spy: 'OFF RADAR', plain: 'no signal' },
}

const COLORS: Record<RunStatus, string> = {
  running: PALETTE.running,
  done: PALETTE.done,
  failed: PALETTE.failed,
  killed: PALETTE.killed,
  ended: PALETTE.ended,
  unknown: PALETTE.ended,
}

const EMOJI_DOTS: Record<RunStatus, string> = {
  running: '●',
  done: '✓',
  failed: '✗',
  killed: '■',
  ended: '◆',
  unknown: '?',
}

const ASCII_DOTS: Record<RunStatus, string> = {
  running: '*',
  done: '+',
  failed: 'x',
  killed: 'x',
  ended: '~',
  unknown: '?',
}

export function statusWords(s: RunStatus): { spy: string; plain: string } {
  const w = WORDS[s]
  return { spy: w.spy, plain: w.plain }
}

export function statusColor(s: RunStatus): string {
  return COLORS[s]
}

export function glyphs(mode: 'emoji' | 'ascii'): { duck: string; dot: Record<RunStatus, string> } {
  return mode === 'ascii'
    ? { duck: '>o)', dot: { ...ASCII_DOTS } }
    : { duck: '🦆', dot: { ...EMOJI_DOTS } }
}
