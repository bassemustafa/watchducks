import { expect, test } from 'claude-code/testing'

import type { Ledger, Run, Usage } from '../../types'
import { buildReport, projectReport } from '../../src/adapters/child-report'
import { parseCostMode, shownCost, shownHq, storedCost, type Costed, type Pricing } from '../../src/cost'
import { addRunsToDays, recordFromLedger, stationRowsFromLedger } from '../../src/history'
import { emptyLedger, reduce, totals } from '../../src/ledger'
import type { PriceTable } from '../../src/price'

function near(a: number | null | undefined, b: number): void {
  expect(typeof a === 'number' && Math.abs(a - b) < 1e-9).toBe(true)
}

// x/m costs $1 per million input and $2 per million output; zz-unknown has no price anywhere
const TABLE: PriceTable = { 'x/m': { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } }
const TOKENS: Usage = { uncached: 1_000_000, output: 1_000_000, cacheRead: 0, cacheWrite: 0 } // $3 at x/m
const NONE: Usage = { uncached: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

const c = (over: Partial<Costed>): Costed => ({ cost: null, costSource: null, usage: TOKENS, model: 'x/m', ...over })
const shown = (item: Costed, mode: 'auto' | 'calculate' | 'display') => shownCost(item, mode, TABLE)

test('parseCostMode: only calculate and display change the default', () => {
  expect(parseCostMode('calculate')).toBe('calculate')
  expect(parseCostMode('display')).toBe('display')
  expect(parseCostMode('auto')).toBe('auto')
  expect(parseCostMode('nonsense')).toBe('auto')
  expect(parseCostMode(undefined)).toBe('auto')
})

test('display: only a reported cost is shown, never an estimate', () => {
  expect(shown(c({ cost: 0.4, costSource: 'reported' }), 'display')).toEqual({ cost: 0.4, source: 'reported' })
  expect(shown(c({ cost: 0, costSource: 'reported' }), 'display')).toEqual({ cost: 0, source: 'reported' })
  expect(shown(c({ cost: 0.4, costSource: 'estimated' }), 'display')).toEqual({ cost: null, source: null })
  expect(shown(c({}), 'display')).toEqual({ cost: null, source: null })
})

test('calculate: always an estimate from the tokens when a rate is known, else the stored cost', () => {
  expect(shown(c({ cost: 0.4, costSource: 'reported' }), 'calculate')).toEqual({ cost: 3, source: 'estimated' })
  expect(shown(c({ cost: 0, costSource: 'reported' }), 'calculate')).toEqual({ cost: 3, source: 'estimated' })
  expect(shown(c({}), 'calculate')).toEqual({ cost: 3, source: 'estimated' })
  // no rate: the stored cost as stored
  expect(shown(c({ model: 'zz-unknown', cost: 0.4, costSource: 'reported' }), 'calculate')).toEqual({ cost: 0.4, source: 'reported' })
  expect(shown(c({ model: 'zz-unknown' }), 'calculate')).toEqual({ cost: null, source: null })
  expect(shown(c({ model: undefined, cost: 0.4, costSource: 'reported' }), 'calculate')).toEqual({ cost: 0.4, source: 'reported' })
  // a stored estimate was priced from the tokens request by request: it stays
  expect(shown(c({ cost: 1.5, costSource: 'estimated' }), 'calculate')).toEqual({ cost: 1.5, source: 'estimated' })
})

test('auto: a reported cost above $0 is reported; a reported $0 is estimated when tokens flowed', () => {
  expect(shown(c({ cost: 0.4, costSource: 'reported' }), 'auto')).toEqual({ cost: 0.4, source: 'reported' })
  expect(shown(c({ cost: 0, costSource: 'reported' }), 'auto')).toEqual({ cost: 3, source: 'estimated', reportedZero: true })
  // zero tokens: the $0 is real
  expect(shown(c({ cost: 0, costSource: 'reported', usage: NONE }), 'auto')).toEqual({ cost: 0, source: 'reported' })
  expect(shown(c({ cost: 0, costSource: 'reported', usage: null }), 'auto')).toEqual({ cost: 0, source: 'reported' })
  // tokens but no rate: the reported $0 stays
  expect(shown(c({ cost: 0, costSource: 'reported', model: 'zz-unknown' }), 'auto')).toEqual({ cost: 0, source: 'reported' })
})

test('auto: a stored estimate stays, no cost is estimated when a rate is known, else null', () => {
  expect(shown(c({ cost: 1.5, costSource: 'estimated' }), 'auto')).toEqual({ cost: 1.5, source: 'estimated' })
  expect(shown(c({}), 'auto')).toEqual({ cost: 3, source: 'estimated' })
  expect(shown(c({ model: 'zz-unknown' }), 'auto')).toEqual({ cost: null, source: null })
  expect(shown(c({ usage: null }), 'auto')).toEqual({ cost: null, source: null })
  expect(shown(c({ model: undefined }), 'auto')).toEqual({ cost: null, source: null })
})

test('a stored partial flag follows a stored cost but not an estimate that replaced it', () => {
  expect(shown(c({ cost: 1.5, costSource: 'estimated', costPartial: true }), 'auto')).toEqual({ cost: 1.5, source: 'estimated', partial: true })
  expect(shown(c({ cost: null, costPartial: true }), 'auto')).toEqual({ cost: 3, source: 'estimated' })
  expect(storedCost({ cost: 2, costSource: 'estimated', costPartial: true })).toEqual({ cost: 2, source: 'estimated', partial: true })
})

const rows = (...r: Array<Partial<NonNullable<Run['rows']>[number]>>): NonNullable<Run['rows']> =>
  r.map(x => ({ implementer: 'opencode' as const, model: 'x/m', usage: TOKENS, cost: null, costSource: null, ...x }))

test('a run with child rows applies the rule to each row and sums them', () => {
  const run = c({ cost: 0.4, costSource: 'reported', model: 'claude-x', rows: rows({ cost: 0.1, costSource: 'reported' }, { cost: 0, costSource: 'reported' }, { model: 'zz-unknown' }) })
  // auto: 0.1 reported + (reported $0 -> $3 estimated) + an unpriced row left out, and the run is partial
  expect(shown(run, 'auto')).toEqual({ cost: 3.1, source: 'estimated', reportedZero: true, partial: true })
  // display: only the reported rows
  expect(shown(run, 'display')).toEqual({ cost: 0.1, source: 'reported', partial: true })
  // calculate: x/m rows are priced again, the unpriced row has nothing to show
  expect(shown(run, 'calculate')).toEqual({ cost: 6, source: 'estimated', partial: true })
  // every row reported above $0 -> reported, and complete
  expect(shown(c({ rows: rows({ cost: 1, costSource: 'reported' }, { cost: 2, costSource: 'reported' }) }), 'auto')).toEqual({ cost: 3, source: 'reported' })
  // no row has a cost
  expect(shown(c({ rows: rows({ model: 'zz-unknown' }) }), 'auto')).toEqual({ cost: null, source: null, partial: true })
})

test('the main loop spend is a row per model, every figure an estimate', () => {
  const spend = (cost: number | null, over: Partial<Ledger['hq']> = {}) => ({ usage: TOKENS, cost, costPartial: false, ...over })
  const l = { hq: spend(3), hqByModel: { 'x/m': spend(3), 'zz-unknown': spend(null, { costPartial: true }) } }
  expect(shownHq(l, 'auto', TABLE)).toEqual({ cost: 3, source: 'estimated', partial: true })
  expect(shownHq(l, 'display', TABLE)).toEqual({ cost: null, source: null, partial: true })
  // a ledger without the split is one row
  expect(shownHq({ hq: spend(null) }, 'auto', TABLE)).toEqual({ cost: null, source: null })
})

// ---- the sinks read the same function

const T0 = Date.UTC(2026, 9, 9, 10)
function run(id: string, over: Partial<Run>): Run {
  return {
    id, kind: 'relay', codename: 'TEAL-00', implementer: 'opencode', readOnly: false, status: 'done',
    startedAt: T0, endedAt: T0 + 1000, usage: TOKENS, usageSource: 'stats', model: 'x/m',
    cost: 0, costSource: 'reported', costPartial: false,
    editCalls: 0, bugsReported: 0, reviews: [], suspectedHandlers: [], ...over,
  }
}
const ledgerOf = (...runs: Run[]): Ledger => ({
  ...emptyLedger('s1', T0),
  runs: Object.fromEntries(runs.map(r => [r.id, r])),
  order: runs.map(r => r.id),
})
const pricing = (mode: Pricing['mode']): Pricing => ({ table: TABLE, mode })

test('totals: without pricing the stored cost, with pricing the shown one, by implementer too', () => {
  const l = ledgerOf(run('a', {}), run('b', { cost: 0.5, costSource: 'reported' }))
  near(totals(l).cost, 0.5)
  near(totals(l, pricing('auto')).cost, 3.5)
  near(totals(l, pricing('auto')).byImplementer['opencode'], 3.5)
  near(totals(l, pricing('display')).cost, 0.5)
  near(totals(l, pricing('calculate')).cost, 6)
  const none = ledgerOf(run('c', { cost: null, costSource: null, model: 'zz-unknown' }))
  expect(totals(none, pricing('auto')).cost).toBeNull()
  expect(totals(none, pricing('auto')).costPartial).toBe(true)
})

test('history: a bucket takes the shown cost with its source; no pricing keeps the stored one', () => {
  const l = ledgerOf(run('a', {}))
  const key = 'opencode|x/m'
  const stored = recordFromLedger(l).days['2026-10-09']![key]!
  expect([stored.costReported, stored.costEstimated, stored.costOps]).toEqual([0, 0, 1])
  const auto = recordFromLedger(l, pricing('auto')).days['2026-10-09']![key]!
  expect([auto.costReported, auto.costEstimated, auto.costOps]).toEqual([0, 3, 1])
  const display = recordFromLedger(l, pricing('display')).days['2026-10-09']![key]!
  expect([display.costReported, display.costEstimated, display.costOps]).toEqual([0, 0, 1])
  // the live board reads the same
  near(stationRowsFromLedger(l, pricing('auto'))[0]!.costEstimated, 3)
  expect(addRunsToDays({}, [run('a', {})], pricing('calculate'))['2026-10-09']![key]!.costEstimated).toBe(3)
})

test('history: child rows are priced row by row', () => {
  const parent = run('p', { implementer: 'claude', model: 'claude-x', cost: 0, costSource: 'reported', rows: rows({ cost: 0, costSource: 'reported' }) })
  const day = recordFromLedger(ledgerOf(parent), pricing('auto')).days['2026-10-09']!
  expect(day['opencode|x/m']!.costEstimated).toBe(3)
  expect(day['claude|claude-x']!.costEstimated).toBe(0)
})

test('/flock clear retires the days under the cost mode the clear carries', () => {
  const l = ledgerOf(run('a', {}))
  const key = 'opencode|x/m'
  const auto = reduce(l, { type: 'clear', at: T0 + 5000, mode: 'auto' }, TABLE).retired['2026-10-09']![key]!
  expect(auto.costEstimated).toBe(3)
  const display = reduce(l, { type: 'clear', at: T0 + 5000, mode: 'display' }, TABLE).retired['2026-10-09']![key]!
  expect(display.costEstimated).toBe(0)
  const bare = reduce(l, { type: 'clear', at: T0 + 5000 }, TABLE).retired['2026-10-09']![key]!
  expect(bare.costEstimated).toBe(3)
})

test('the child report carries the costs the child shows', () => {
  const l = ledgerOf(run('a', {}))
  const now = T0 + 5000
  const rowOf = (text: string) => projectReport(text, now)!.rows.find(r => r.model === 'x/m')!
  const stored = rowOf(buildReport(l, T0, undefined, 'running', now))
  expect(stored.cost).toBe(0)
  expect(stored.costSource).toBe('reported')
  const auto = rowOf(buildReport(l, T0, undefined, 'running', now, pricing('auto')))
  near(auto.cost, 3)
  expect(auto.costSource).toBe('estimated')
  const display = rowOf(buildReport(l, T0, undefined, 'running', now, pricing('display')))
  expect(display.cost).toBe(0)
  expect(display.costSource).toBe('reported')
})
