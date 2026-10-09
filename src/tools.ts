import { atom, read, update } from 'claude-code'
import type { EngineInterface, On, ToolSpec } from 'claude-code'

import type { Ledger } from '../types'
import { reduce, resolveRun, type Action } from './ledger'
import type { PriceTable } from './price'
import { INITIAL_LEDGER } from './state'

const ledgerAtom = atom({ plugin: 'watchducks', key: 'ledger' } as const, INITIAL_LEDGER)

// The two tools the model may call (spec §8): a read-only roster and the
// verdict that records a review. Their answers carry codenames, kinds and
// numbers only. `src/lifecycle.ts` registers the specs at session.start.

const MAX_REF = 80
const MAX_BUGS = 10000
const MAX_EDITS = 100000

export const ROSTER_SPEC: ToolSpec = {
  name: 'roster',
  description: "Lists this session's delegated runs, one line each: codename · kind · implementer · model · lane · status. Read-only.",
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
}

export const VERDICT_SPEC: ToolSpec = {
  name: 'verdict',
  description:
    'Records the outcome of reviewing a delegated run: the run reviewed (codename or id), optionally the reviewing run, the number of bugs found and the number of edits made.',
  inputSchema: {
    type: 'object',
    properties: {
      target: { type: 'string', maxLength: MAX_REF },
      reviewer: { type: 'string', maxLength: MAX_REF },
      bugs: { type: 'integer', minimum: 0, maximum: MAX_BUGS },
      edits: { type: 'integer', minimum: 0, maximum: MAX_EDITS },
    },
    required: ['target'],
    additionalProperties: false,
  },
}

/** One line per run in creation order; 'No operatives yet.' when there are none. */
export function rosterLines(ledger: Ledger): string {
  const lines: string[] = []
  for (const id of ledger.order) {
    const run = Object.hasOwn(ledger.runs, id) ? ledger.runs[id] : undefined
    if (!run) continue
    lines.push(`${run.codename} · ${run.kind} · ${run.implementer} · ${run.model ?? '—'} · ${run.lane ?? '—'} · ${run.status}`)
  }
  return lines.length === 0 ? 'No operatives yet.' : lines.join('\n')
}

type Verdict = { target: string; reviewer?: string; bugs?: number; edits?: number }

function validRef(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= MAX_REF
}

function validCount(v: unknown, max: number): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= max
}

/** The checked fields, or a short text naming what was wrong. Reads the four fields by name only. */
export function checkVerdict(input: { target?: unknown; reviewer?: unknown; bugs?: unknown; edits?: unknown }): Verdict | string {
  if (!validRef(input.target)) return `target must be a string of 1–${MAX_REF} characters`
  const verdict: Verdict = { target: input.target }
  if (input.reviewer !== undefined) {
    if (!validRef(input.reviewer)) return `reviewer must be a string of 1–${MAX_REF} characters`
    verdict.reviewer = input.reviewer
  }
  if (input.bugs !== undefined) {
    if (!validCount(input.bugs, MAX_BUGS)) return `bugs must be an integer 0–${MAX_BUGS}`
    verdict.bugs = input.bugs
  }
  if (input.edits !== undefined) {
    if (!validCount(input.edits, MAX_EDITS)) return `edits must be an integer 0–${MAX_EDITS}`
    verdict.edits = input.edits
  }
  return verdict
}

/** The answer text, and the action to dispatch when the verdict names runs the ledger knows. */
export function judge(ledger: Ledger, verdict: Verdict, at: number): { text: string; action?: Action } {
  const target = resolveRun(ledger, verdict.target)
  if (target === undefined) return { text: 'target not found' }
  if (target === 'ambiguous') return { text: 'target is ambiguous' }
  let reviewerName = 'HQ'
  let reviewerId: string | undefined
  if (verdict.reviewer !== undefined) {
    const reviewer = resolveRun(ledger, verdict.reviewer)
    if (reviewer === undefined) return { text: 'reviewer not found' }
    if (reviewer === 'ambiguous') return { text: 'reviewer is ambiguous' }
    reviewerName = reviewer.codename
    reviewerId = reviewer.id
  }
  const action: Action = {
    type: 'verdict',
    targetId: target.id,
    ...(reviewerId !== undefined ? { reviewerId } : {}),
    ...(verdict.bugs !== undefined ? { bugs: verdict.bugs } : {}),
    ...(verdict.edits !== undefined ? { edits: verdict.edits } : {}),
    at,
  }
  return {
    text: `Recorded: ${reviewerName} vetted ${target.codename} · ${verdict.bugs ?? '?'} leaks · ${verdict.edits ?? '?'} patches`,
    action,
  }
}

async function send($: EngineInterface, action: Action, table: PriceTable): Promise<void> {
  await update($, ledgerAtom, l => reduce(l, action, table))
}

export function registerTools(on: On, table: PriceTable): void {
  on('tool.call', { tool: 'mcp__watchducks__roster' }, async $ => {
    return { result: rosterLines(await read($, ledgerAtom)) }
  }).catch(() => ({ result: 'The roster is not available right now.' }))

  on('tool.call', { tool: 'mcp__watchducks__verdict' }, async ($, e) => {
    const checked = checkVerdict({ target: e.target, reviewer: e.reviewer, bugs: e.bugs, edits: e.edits })
    if (typeof checked === 'string') return { result: checked }
    const judged = judge(await read($, ledgerAtom), checked, Date.now())
    if (judged.action) await send($, judged.action, table)
    return { result: judged.text }
  }).catch(() => ({ result: 'The verdict could not be recorded.' }))
}
