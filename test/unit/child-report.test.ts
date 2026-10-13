import { expect, test } from 'claude-code/testing'

import {
  buildReport,
  CHILD_DIR,
  CHILD_ID,
  CHILD_SCHEMA,
  mainModel,
  matchReports,
  MAX_REPORT_BYTES,
  projectReport,
  reportDir,
  STALE_MS,
  type ChildReport,
} from '../../src/adapters/child-report'
import { fingerprint } from '../../src/collect/relay'
import { emptyLedger, reduce, type Action } from '../../src/ledger'
import { PRICES } from '../../src/price'
import type { Implementer, Ledger, Run } from '../../types'

const T0 = Date.UTC(2026, 9, 12, 12)
const OPUS = 'claude-opus-5-5'
const OC_MODEL = 'openai/gpt-6.1-sol'
const apply = (l: Ledger, ...actions: Action[]): Ledger => actions.reduce((acc, a) => reduce(acc, a, PRICES), l)
const used = (uncached: number) => ({ uncached, output: 10, cacheRead: 0, cacheWrite: 0 })
const cliStart = (id: string, implementer: 'opencode' | 'claude' = 'opencode', model = OC_MODEL, workdir = '/w'): Action =>
  ({ type: 'bashStart', id, cls: { kind: 'cli', implementer, model, workdir }, at: T0 })
const adapter = (id: string, uncached: number, over: Partial<Extract<Action, { type: 'adapterUsage' }>> = {}): Action =>
  ({ type: 'adapterUsage', id, source: 'stats', usage: used(uncached), cost: 0.5, costSource: 'reported', at: T0 + 5000, ...over })
const hqStep = (index: number, model = OPUS): Action => ({
  type: 'step', turnId: 't1', index, model, at: T0 + 1000,
  usage: { model, input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
})

function near(a: number | null | undefined, b: number): void { expect(typeof a === 'number' && Math.abs(a - b) < 1e-9).toBe(true) }

type Row = NonNullable<Run['rows']>[number]
const row = (model: string, uncached: number, over: Partial<Row> = {}): Row =>
  ({ implementer: 'claude-code', model, usage: used(uncached), cost: 0.25, costSource: 'estimated', ...over })

const NOW = T0 + 10_000
const iso = (ms: number): string => new Date(ms).toISOString()
const reportText = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({ schema: CHILD_SCHEMA, startedAt: iso(T0), updatedAt: iso(NOW), workdirKey: 'abc12', status: 'running', rows: [row(OPUS, 100)], ...over })
const parsed = (over: Record<string, unknown> = {}): ChildReport => {
  const r = projectReport(reportText(over), NOW)
  expect(r).not.toBeNull()
  return r!
}

test('reportDir names the parent only by its fingerprint under the temp root', () => {
  expect(reportDir('/tmp', 'parent-1')).toBe(`/tmp/${CHILD_DIR}/${fingerprint('parent-1')}`)
  expect(reportDir('/tmp/', 'parent-1')).toBe(reportDir('/tmp', 'parent-1'))
  expect(reportDir('/tmp', 'parent-1').includes('parent-1')).toBe(false)
})

test('buildReport writes only the allowed keys and nothing of a run: no codename, path or text', () => {
  const l = apply(emptyLedger('s1', T0), hqStep(0),
    { type: 'spawn', id: 'a1', agentType: 'SENTINEL-agent-type', requestedModel: OPUS, at: T0 },
    { type: 'bashStart', id: 'r1', cls: { kind: 'relay', implementer: 'opencode', lane: 'SENTINEL-lane', model: OC_MODEL, readOnly: false, workdir: '/work/SENTINEL-dir', outDir: '/out/SENTINEL-out' }, at: T0 },
    adapter('r1', 300))
  const text = buildReport(l, T0, 'abc12', 'running', NOW)
  const out = JSON.parse(text) as Record<string, unknown>
  expect(Object.keys(out).sort()).toEqual(['rows', 'schema', 'startedAt', 'status', 'updatedAt', 'workdirKey'])
  expect(out['schema']).toBe(CHILD_SCHEMA)
  expect(out['startedAt']).toBe(iso(T0))
  expect(out['updatedAt']).toBe(iso(NOW))
  expect(out['status']).toBe('running')
  expect(text.includes('SENTINEL')).toBe(false)
  expect(text.includes('/work')).toBe(false)
  for (const run of Object.values(l.runs)) expect(text.includes(run.codename)).toBe(false)
  for (const r of out['rows'] as Array<Record<string, unknown>>) {
    expect(Object.keys(r).sort()).toEqual(['cost', 'costSource', 'implementer', 'model', 'usage'])
    expect(Object.keys(r['usage'] as object).sort()).toEqual(['cacheRead', 'cacheWrite', 'output', 'uncached'])
  }
  // the text is a report the parent accepts, with the same rows
  const back = projectReport(text, NOW)
  expect(back).not.toBeNull()
  expect(back!.rows.length).toBe(2)
  expect(back!.workdirKey).toBe('abc12')
})

test('buildReport leaves workdirKey out when the child has none', () => {
  const out = JSON.parse(buildReport(emptyLedger('s1', T0), T0, undefined, 'done', NOW)) as Record<string, unknown>
  expect(Object.keys(out).sort()).toEqual(['rows', 'schema', 'startedAt', 'status', 'updatedAt'])
  expect(out['rows']).toEqual([])
  expect(out['status']).toBe('done')
})

test('rows merge the same implementer × model: HQ and agents of one model are one claude-code row', () => {
  const l = apply(emptyLedger('s1', T0), hqStep(0), hqStep(1),
    { type: 'spawn', id: 'a1', agentType: 'Explore', requestedModel: OPUS, at: T0 },
    { type: 'step', loop: 'a1', turnId: 't2', index: 0, model: OPUS, at: T0 + 2000,
      usage: { model: OPUS, input_tokens: 500, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
    cliStart('r1'), cliStart('r2'), adapter('r1', 100), adapter('r2', 200))
  const out = projectReport(buildReport(l, T0, undefined, 'running', NOW), NOW)!
  const keys = out.rows.map(r => `${r.implementer}|${r.model}`).sort()
  expect(keys).toEqual([`claude-code|${OPUS}`, `opencode|${OC_MODEL}`])
  const cc = out.rows.find(r => r.implementer === 'claude-code')!
  expect(cc.usage).toEqual({ uncached: 2500, output: 250, cacheRead: 0, cacheWrite: 0 })
  expect(cc.costSource).toBe('estimated')
  const oc = out.rows.find(r => r.implementer === 'opencode')!
  expect(oc.usage).toEqual({ uncached: 300, output: 20, cacheRead: 0, cacheWrite: 0 })
  near(oc.cost, 1)
  expect(oc.costSource).toBe('reported')
})

// changed with the interval allocation: runs that hold a share each contribute their own amounts, summed plainly
test('runs that hold a share each add their own amounts, and a run with child rows contributes its rows (not itself)', () => {
  const shared = { sharedSize: 3, cost: 1.5 }
  const l = apply(emptyLedger('s1', T0), cliStart('r1'), cliStart('r2'), cliStart('r3'),
    adapter('r1', 300, shared), adapter('r2', 300, shared), adapter('r3', 300, shared),
    cliStart('c1', 'claude', OPUS),
    adapter('c1', 999, { source: 'child', cost: 9, rows: [row(OPUS, 40), row(OC_MODEL, 7, { implementer: 'opencode', cost: null, costSource: null })] }))
  const out = projectReport(buildReport(l, T0, undefined, 'running', NOW), NOW)!
  const byKey = new Map(out.rows.map(r => [`${r.implementer}|${r.model}`, r]))
  expect([...byKey.keys()].sort()).toEqual([`claude-code|${OPUS}`, `opencode|${OC_MODEL}`])
  // the three shares of 300, plus the child's 7 from its rows
  expect(byKey.get(`opencode|${OC_MODEL}`)!.usage.uncached).toBe(907)
  near(byKey.get(`opencode|${OC_MODEL}`)!.cost, 4.5)
  // the child's own 999 is not counted: its rows are
  expect(byKey.get(`claude-code|${OPUS}`)!.usage.uncached).toBe(40)
  expect(byKey.has(`claude|${OPUS}`)).toBe(false)
})

test('a cost that is only partly reported is estimated when rows merge', () => {
  const l = apply(emptyLedger('s1', T0), cliStart('r1'), cliStart('c1', 'claude', OC_MODEL),
    adapter('r1', 10), adapter('c1', 0, { source: 'child', rows: [row(OC_MODEL, 5, { implementer: 'opencode', cost: 0.5, costSource: 'estimated' })] }))
  const out = projectReport(buildReport(l, T0, undefined, 'running', NOW), NOW)!
  const oc = out.rows.find(r => r.implementer === 'opencode')!
  near(oc.cost, 1)
  expect(oc.costSource).toBe('estimated')
})

test('40 distinct pairs give 32 rows and the largest by tokens stay', () => {
  const hqByModel: NonNullable<Ledger['hqByModel']> = {}
  for (let i = 1; i <= 40; i++) hqByModel[`model-${i}`] = { usage: { uncached: i * 10, output: 0, cacheRead: 0, cacheWrite: 0 }, cost: null, costPartial: false }
  const l: Ledger = { ...emptyLedger('s1', T0), hqByModel }
  const out = projectReport(buildReport(l, T0, undefined, 'running', NOW), NOW)!
  expect(out.rows.length).toBe(32)
  const kept = out.rows.map(r => r.usage.uncached)
  expect(Math.min(...kept)).toBe(90)
  expect(Math.max(...kept)).toBe(400)
  expect(out.rows[0]!.model).toBe('model-40')
  // a row with no cost is null, not zero
  expect(out.rows[0]!.cost).toBeNull()
  expect(out.rows[0]!.costSource).toBeNull()
})

test('a model name the parent would refuse is made safe, so the report still projects', () => {
  const hqByModel = { 'claude opus [1m]': { usage: used(5), cost: null, costPartial: false } }
  const out = projectReport(buildReport({ ...emptyLedger('s1', T0), hqByModel }, T0, undefined, 'running', NOW), NOW)
  expect(out).not.toBeNull()
  expect(out!.rows[0]!.model).toBe('claude_opus__1m_')
})

test('projectReport reads a good report and drops everything outside the allow-list', () => {
  const r = projectReport(reportText({ extra: 'x', prompt: 'p' }), NOW)!
  expect(Object.keys(r).sort()).toEqual(['rows', 'startedAt', 'status', 'updatedAt', 'workdirKey'])
  expect(r.startedAt).toBe(T0)
  expect(r.updatedAt).toBe(NOW)
  expect(r.rows).toEqual([row(OPUS, 100)])
  expect(Object.keys(projectReport(reportText({ workdirKey: undefined }), NOW)!).includes('workdirKey')).toBe(false)
})

test('projectReport rejects other schemas, bad JSON and bad shapes', () => {
  expect(projectReport(reportText({ schema: 'watchducks.child.v2' }), NOW)).toBeNull()
  expect(projectReport(reportText({ schema: undefined }), NOW)).toBeNull()
  expect(projectReport('not json', NOW)).toBeNull()
  expect(projectReport('[]', NOW)).toBeNull()
  expect(projectReport(reportText({ status: 'paused' }), NOW)).toBeNull()
  expect(projectReport(reportText({ startedAt: 'yesterday' }), NOW)).toBeNull()
  expect(projectReport(reportText({ workdirKey: 7 }), NOW)).toBeNull()
  expect(projectReport(reportText({ rows: {} }), NOW)).toBeNull()
  expect(projectReport(reportText({ rows: [row('bad model!', 1)] }), NOW)).toBeNull()
  expect(projectReport(reportText({ rows: [row(OPUS, 1, { implementer: 'robot' as Implementer })] }), NOW)).toBeNull()
  expect(projectReport(reportText({ rows: [row(OPUS, 1, { cost: 0.5, costSource: null })] }), NOW)).toBeNull()
  expect(projectReport(reportText({ rows: [row(OPUS, 1, { cost: null, costSource: 'reported' })] }), NOW)).toBeNull()
})

test('projectReport rejects an oversize report', () => {
  const big = reportText({ pad: 'x'.repeat(MAX_REPORT_BYTES) })
  expect(big.length > MAX_REPORT_BYTES).toBe(true)
  expect(projectReport(big, NOW)).toBeNull()
  // multi-byte text is counted in bytes: under the limit in characters, over it in bytes
  const wide = reportText({ pad: '€'.repeat(MAX_REPORT_BYTES / 3) })
  expect(wide.length < MAX_REPORT_BYTES).toBe(true)
  expect(projectReport(wide, NOW)).toBeNull()
})

test('projectReport rejects non-numeric, negative and huge usage and costs', () => {
  const withUsage = (usage: unknown) => reportText({ rows: [{ ...row(OPUS, 1), usage }] })
  expect(projectReport(withUsage(used(1)), NOW)).not.toBeNull()
  expect(projectReport(withUsage({ ...used(1), uncached: '5' }), NOW)).toBeNull()
  expect(projectReport(withUsage({ ...used(1), output: null }), NOW)).toBeNull()
  expect(projectReport(withUsage({ uncached: 1, output: 1, cacheRead: 1 }), NOW)).toBeNull()
  expect(projectReport(withUsage({ ...used(1), cacheWrite: -1 }), NOW)).toBeNull()
  expect(projectReport(withUsage({ ...used(1), cacheRead: 1e13 }), NOW)).toBeNull()
  expect(projectReport(withUsage('lots'), NOW)).toBeNull()
  expect(projectReport(reportText({ rows: [{ ...row(OPUS, 1), cost: '0.5' }] }), NOW)).toBeNull()
  expect(projectReport(reportText({ rows: [row(OPUS, 1, { cost: 1e7 })] }), NOW)).toBeNull()
})

test('projectReport takes 32 rows and rejects 33', () => {
  const rows = (n: number) => Array.from({ length: n }, (_, i) => row(`m-${i}`, i))
  expect(projectReport(reportText({ rows: rows(32) }), NOW)!.rows.length).toBe(32)
  expect(projectReport(reportText({ rows: rows(33) }), NOW)).toBeNull()
})

test('projectReport rejects a report whose updatedAt is older than 24 h and keeps one at the edge', () => {
  expect(projectReport(reportText({ updatedAt: iso(NOW - STALE_MS) }), NOW)).not.toBeNull()
  expect(projectReport(reportText({ updatedAt: iso(NOW - STALE_MS - 1) }), NOW)).toBeNull()
})

test('mainModel is the claude-code row with the most tokens', () => {
  const r = parsed({ rows: [row('small', 10), row('big', 900), row('oc', 5000, { implementer: 'opencode' })] })
  expect(mainModel(r)).toBe('big')
  expect(mainModel(parsed({ rows: [row('oc', 5000, { implementer: 'opencode' })] }))).toBeUndefined()
  expect(mainModel(parsed({ rows: [] }))).toBeUndefined()
})

const run = (id: string, startedAt: number, over: Partial<Run> = {}): Run => {
  const l = apply(emptyLedger('s1', startedAt), { ...cliStart(id, 'claude', OPUS), at: startedAt })
  return { ...l.runs[id]!, startedAt, ...over }
}
const rep = (file: string, startedAt: number, over: Record<string, unknown> = {}): { file: string; report: ChildReport } =>
  ({ file, report: parsed({ startedAt: iso(startedAt), ...over }) })

test('matchReports: the window is 5 s before to 60 s after, edges included', () => {
  const r = run('r1', T0, { workdirKey: 'abc12', model: OPUS })
  const at = (offset: number) => matchReports([r], [rep('f', T0 + offset)], new Set())
  expect(at(-5000)).toEqual([{ id: 'r1', file: 'f' }])
  expect(at(60_000)).toEqual([{ id: 'r1', file: 'f' }])
  expect(at(0)).toEqual([{ id: 'r1', file: 'f' }])
  expect(at(-5001)).toEqual([])
  expect(at(60_001)).toEqual([])
})

test('matchReports: workdir and model must agree when the run knows them', () => {
  const known = run('r1', T0, { workdirKey: 'abc12', model: OPUS })
  expect(matchReports([known], [rep('f', T0, { workdirKey: 'other' })], new Set())).toEqual([])
  expect(matchReports([known], [rep('f', T0, { workdirKey: undefined })], new Set())).toEqual([])
  expect(matchReports([known], [rep('f', T0, { rows: [row('claude-sonnet-5-5', 5)] })], new Set())).toEqual([])
  expect(matchReports([known], [rep('f', T0, { rows: [row(OPUS, 5, { implementer: 'opencode' })] })], new Set())).toEqual([])
  // a run that knows neither takes any report in the window
  const blank = run('r2', T0)
  delete (blank as { workdirKey?: string }).workdirKey
  delete (blank as { model?: string }).model
  expect(matchReports([blank], [rep('f', T0, { workdirKey: 'other', rows: [row('x', 1)] })], new Set())).toEqual([{ id: 'r2', file: 'f' }])
  // a run that knows only its folder ignores the model
  const folderOnly = run('r3', T0, { workdirKey: 'abc12' })
  delete (folderOnly as { model?: string }).model
  expect(matchReports([folderOnly], [rep('f', T0, { rows: [row('x', 1)] })], new Set())).toEqual([{ id: 'r3', file: 'f' }])
})

test('matchReports: identical runs and reports pair in start order, one each', () => {
  const runs = [run('late', T0 + 1000, { workdirKey: 'abc12' }), run('early', T0, { workdirKey: 'abc12' })]
  const reports = [rep('b.json', T0 + 2000), rep('a.json', T0 + 500)]
  expect(matchReports(runs, reports, new Set())).toEqual([{ id: 'early', file: 'a.json' }, { id: 'late', file: 'b.json' }])
  // two runs, one report: the earliest run takes it
  expect(matchReports(runs, [rep('a.json', T0 + 500)], new Set())).toEqual([{ id: 'early', file: 'a.json' }])
  // one run, two reports: it takes the earliest
  expect(matchReports([runs[1]!], reports, new Set())).toEqual([{ id: 'early', file: 'a.json' }])
  // the inputs are not reordered
  expect(runs[0]!.id).toBe('late')
  expect(reports[0]!.file).toBe('b.json')
})

test('matchReports: claimed files are skipped', () => {
  const runs = [run('r1', T0, { workdirKey: 'abc12' })]
  const reports = [rep('a.json', T0), rep('b.json', T0 + 1000)]
  expect(matchReports(runs, reports, new Set(['a.json']))).toEqual([{ id: 'r1', file: 'b.json' }])
  expect(matchReports(runs, reports, new Set(['a.json', 'b.json']))).toEqual([])
})

test('CHILD_ID accepts a UUID and rejects anything that is not a plain file name', () => {
  expect(CHILD_ID.test('3f2b8c1e-9a4d-4e6f-b1c2-0d5e7a8b9c10')).toBe(true)
  for (const bad of ['..', 'a/b', 'a.b', '', 'a'.repeat(129)]) expect(CHILD_ID.test(bad)).toBe(false)
  expect(CHILD_ID.test('a'.repeat(128))).toBe(true)
})
