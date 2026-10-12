import { expect, test } from 'claude-code/testing'

import {
  attribute,
  baselineFrom,
  capped,
  chainByOverlap,
  exceedsBytes,
  holdUp,
  MAX_STATS_MODELS,
  planShares,
  projectStats,
  rowKey,
  STATS_ARGV,
  STATS_EVERY_MS,
  STATS_RACE_MS,
  type StatsRun,
  type StatsShare,
  type StatsSnapshot,
} from '../../src/adapters/opencode-stats'

const SAMPLE = '{"sessions":5,"tokens":{"input":150005,"output":9587,"reasoning":15219,"cache":{"read":904320,"write":0}},"cost":0,"models":[{"model":{"id":"gpt-6.1-sol","providerID":"openai","variant":"xhigh"},"tokens":{"input":1,"output":2,"reasoning":3,"cache":{"read":4,"write":5}},"cost":0.5}]}'

type Row = { input: number; output: number; reasoning: number; cache: { read: number; write: number } }

function stats(total: Row, models: Array<{ id: string; provider: string; tokens: Row; cost: number }> = [], extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    sessions: 1,
    tokens: total,
    cost: 0,
    models: models.map((m) => ({ model: { id: m.id, providerID: m.provider, variant: 'high' }, tokens: m.tokens, cost: m.cost })),
    ...extra,
  })
}

const row = (input: number, output = 0, reasoning = 0, read = 0, write = 0): Row => ({ input, output, reasoning, cache: { read, write } })

test('a real-shaped stats stdout projects to numbers keyed by provider/model', () => {
  const s = projectStats(SAMPLE, 1234)
  expect(s).toEqual({
    at: 1234,
    sessions: 5,
    total: { input: 150005, output: 9587, reasoning: 15219, cacheRead: 904320, cacheWrite: 0, cost: 0 },
    models: { 'openai/gpt-6.1-sol': { input: 1, output: 2, reasoning: 3, cacheRead: 4, cacheWrite: 5, cost: 0.5 } },
  })
})

test('the argv is the fixed opencode stats command', () => {
  expect([...STATS_ARGV]).toEqual(['opencode', 'stats', '--json', '--days', '1', '--models', '--cost', '--project', '.'])
})

test('title and text fields, and unknown blocks, never reach the snapshot', () => {
  const text = stats(row(1, 2, 3, 4, 5), [{ id: 'm', provider: 'p', tokens: row(1), cost: 0 }], {
    title: 'SENTINEL-TITLE',
    text: 'SENTINEL-TEXT',
    tools: [{ tool: 'bash', text: 'SENTINEL-TOOL' }],
    activity: { title: 'SENTINEL-ACTIVITY' },
    range: { text: 'SENTINEL-RANGE' },
  })
  const s = projectStats(text, 1)
  expect(s).not.toBeNull()
  const json = JSON.stringify(s)
  expect(json).not.toContain('SENTINEL')
  expect(json).not.toContain('title')
  expect(json).not.toContain('text')
  expect(json).not.toContain('variant')
})

test('65 models keep 64', () => {
  const models = Array.from({ length: MAX_STATS_MODELS + 1 }, (_, i) => ({ id: `m${i}`, provider: 'p', tokens: row(i), cost: 0 }))
  const s = projectStats(stats(row(1), models), 1)
  expect(Object.keys(s!.models).length).toBe(64)
  expect(s!.models['p/m63']).toBeDefined()
  expect(s!.models['p/m64']).toBeUndefined()
})

test('a negative, string or missing number nulls the snapshot', () => {
  expect(projectStats(stats(row(-1)), 1)).toBeNull()
  expect(projectStats(stats(row(1, 0, 0, -5)), 1)).toBeNull()
  expect(projectStats(stats({ ...row(1), input: '7' as unknown as number }), 1)).toBeNull()
  expect(projectStats(stats({ ...row(1), output: null as unknown as number }), 1)).toBeNull()
  expect(projectStats(stats(row(1), [], { cost: -0.1 }), 1)).toBeNull()
  expect(projectStats(stats(row(1), [], { cost: 1e6 + 1 }), 1)).toBeNull()
  expect(projectStats(stats(row(1e12 + 1)), 1)).toBeNull()
  expect(projectStats(stats(row(1), [], { sessions: 'many' }), 1)).toBeNull()
  expect(projectStats('{"sessions":1,"tokens":{"input":1,"output":1,"reasoning":1,"cache":{"read":1,"write":NaN}},"cost":0}', 1)).toBeNull()
  expect(projectStats('{"sessions":1,"cost":0,"models":[]}', 1)).toBeNull()
  expect(projectStats('{"sessions":1,"tokens":{"input":1,"output":1,"reasoning":1},"cost":0}', 1)).toBeNull()
})

test('non-JSON and non-object stdout are null', () => {
  expect(projectStats('', 1)).toBeNull()
  expect(projectStats('opencode: command failed', 1)).toBeNull()
  expect(projectStats('[]', 1)).toBeNull()
  expect(projectStats('null', 1)).toBeNull()
})

test('oversize stdout is null', () => {
  const pad = ' '.repeat(1_048_576)
  expect(projectStats(SAMPLE + pad, 1)).toBeNull()
  expect(projectStats(SAMPLE, 1)).not.toBeNull()
})

test('a model row with an unsafe identifier or bad numbers is skipped, the rest stays', () => {
  const text = stats(row(1), [
    { id: 'bad id with spaces', provider: 'p', tokens: row(1), cost: 0 },
    { id: 'ok', provider: 'p', tokens: row(-1), cost: 0 },
    { id: 'fine', provider: 'p', tokens: row(2), cost: 0 },
  ])
  const s = projectStats(text, 1)
  expect(Object.keys(s!.models)).toEqual(['p/fine'])
})

test('one model at two variants adds up under one key', () => {
  const text = stats(row(10), [
    { id: 'm', provider: 'p', tokens: row(1, 2, 3, 4, 5), cost: 0.25 },
    { id: 'm', provider: 'p', tokens: row(10, 20, 30, 40, 50), cost: 0.5 },
  ])
  expect(projectStats(text, 1)!.models['p/m']).toEqual({ input: 11, output: 22, reasoning: 33, cacheRead: 44, cacheWrite: 55, cost: 0.75 })
})

const BASE = projectStats(
  stats(row(100, 10, 5, 1000, 20), [
    { id: 'gpt-6.1-sol', provider: 'openai', tokens: row(40, 4, 2, 400, 8), cost: 0.1 },
    { id: 'other', provider: 'acme', tokens: row(60, 6, 3, 600, 12), cost: 0.2 },
  ], { cost: 0.3 }),
  1,
)!
const LATEST = projectStats(
  stats(row(300, 30, 15, 3000, 60), [
    { id: 'gpt-6.1-sol', provider: 'openai', tokens: row(140, 14, 7, 1400, 28), cost: 0.6 },
    { id: 'other', provider: 'acme', tokens: row(160, 16, 8, 1600, 32), cost: 0.9 },
  ], { cost: 1.5 }),
  2,
)!

test('attribution by the full key uses that model row and the token mapping', () => {
  const a = attribute(BASE, LATEST, 'openai/gpt-6.1-sol')
  expect(a.byModel).toBe(true)
  expect(a.approx).toBe(false)
  // uncached = input; output = output + reasoning
  expect(a.usage).toEqual({ uncached: 100, output: 10 + 5, cacheRead: 1000, cacheWrite: 20 })
  expect(Math.abs(a.cost - 0.5) < 1e-9).toBe(true)
})

test('attribution by the short model id matches the part after the last slash', () => {
  const a = attribute(BASE, LATEST, 'gpt-6.1-sol')
  expect(a.byModel).toBe(true)
  expect(a.usage).toEqual({ uncached: 100, output: 15, cacheRead: 1000, cacheWrite: 20 })
})

test('an unknown or absent model falls back to the project total', () => {
  for (const model of ['nope', 'openai/nope', '', undefined]) {
    const a = attribute(BASE, LATEST, model)
    expect(a.byModel).toBe(false)
    expect(a.approx).toBe(false)
    expect(a.usage).toEqual({ uncached: 200, output: 20 + 10, cacheRead: 2000, cacheWrite: 40 })
    expect(Math.abs(a.cost - 1.2) < 1e-9).toBe(true)
  }
})

test('a short id shared by two providers is ambiguous and falls back to the total', () => {
  const two = projectStats(
    stats(row(10), [
      { id: 'twin', provider: 'a', tokens: row(1), cost: 0 },
      { id: 'twin', provider: 'b', tokens: row(2), cost: 0 },
    ]),
    1,
  )!
  expect(attribute(BASE, two, 'twin').byModel).toBe(false)
  expect(attribute(BASE, two, 'a/twin').byModel).toBe(true)
})

test('a model row that did not exist at the baseline counts from zero', () => {
  const base = projectStats(stats(row(10)), 1)!
  const latest = projectStats(stats(row(50), [{ id: 'm', provider: 'p', tokens: row(7, 1, 1, 2, 3), cost: 0.4 }]), 2)!
  const a = attribute(base, latest, 'p/m')
  expect(a.byModel).toBe(true)
  expect(a.approx).toBe(false)
  expect(a.usage).toEqual({ uncached: 7, output: 2, cacheRead: 2, cacheWrite: 3 })
  expect(Math.abs(a.cost - 0.4) < 1e-9).toBe(true)
})

test('a decreasing counter is clamped at 0 per field and marks the run approximate', () => {
  const base = projectStats(stats(row(500, 50, 5, 900, 10), [], { cost: 2 }), 1)!
  const latest = projectStats(stats(row(100, 80, 5, 1000, 10), [], { cost: 1 }), 2)!
  const a = attribute(base, latest, undefined)
  expect(a.approx).toBe(true)
  expect(a.usage).toEqual({ uncached: 0, output: 30, cacheRead: 100, cacheWrite: 0 })
  expect(a.cost).toBe(0)
  for (const v of [a.usage.uncached, a.usage.output, a.usage.cacheRead, a.usage.cacheWrite, a.cost]) expect(v >= 0).toBe(true)
})

test('a decreasing reasoning counter alone is clamped and marks approximate', () => {
  const base = projectStats(stats(row(1, 1, 9)), 1)!
  const latest = projectStats(stats(row(2, 3, 4)), 2)!
  const a = attribute(base, latest, undefined)
  expect(a.approx).toBe(true)
  expect(a.usage).toEqual({ uncached: 1, output: 2, cacheRead: 0, cacheWrite: 0 })
})

test('identical snapshots attribute zero without approximation', () => {
  const a = attribute(LATEST, LATEST, 'openai/gpt-6.1-sol')
  expect(a.usage).toEqual({ uncached: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
  expect(a.cost).toBe(0)
  expect(a.approx).toBe(false)
})

// ---- review fixes: bytes, rows by provider, project-total residual, exact members, memory

const zero = { uncached: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
const fig = (input: number, cost = 0) => ({ input, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost })
const used = (uncached: number) => ({ ...zero, uncached })

function shot(at: number, sessions: number, models: Record<string, ReturnType<typeof fig>>): StatsSnapshot {
  let input = 0
  let cost = 0
  for (const m of Object.values(models)) {
    input += m.input
    cost += m.cost
  }
  return { at, sessions, total: fig(input, cost), models }
}

const base0 = shot(100, 1, { 'p/m': fig(0), 'q/m': fig(0), 'r/other': fig(0) })
const later = shot(200, 2, { 'p/m': fig(10, 1), 'q/m': fig(20, 2), 'r/other': fig(0) })
function measured(id: string, model: string | undefined, over: Partial<StatsRun> = {}): StatsRun {
  return { id, model, startedAt: 100, endedAt: undefined, base: base0, baseApprox: false, live: true, ...over }
}
const shareOf = (shares: StatsShare[], id: string): StatsShare => shares.find(s => s.id === id)!

test('stdout is capped in bytes, not characters', () => {
  const head = '{"sessions":1,"tokens":{"input":1,"output":1,"reasoning":1,"cache":{"read":1,"write":1}},"cost":0,"junk":"'
  // 600 000 two-byte characters are 1.2 MB: over the cap although the string is shorter than it
  expect(projectStats(head + 'é'.repeat(600_000) + '"}', 1)).toBeNull()
  expect(projectStats(head + 'é'.repeat(100_000) + '"}', 1)).not.toBeNull()
})

test('exceedsBytes counts UTF-8 bytes, a surrogate pair as four', () => {
  expect(exceedsBytes('é'.repeat(3), 6)).toBe(false)
  expect(exceedsBytes('é'.repeat(3), 5)).toBe(true)
  expect(exceedsBytes('😀'.repeat(3), 12)).toBe(false)
  expect(exceedsBytes('😀'.repeat(3), 11)).toBe(true)
  expect(exceedsBytes('€€', 6)).toBe(false)
  expect(exceedsBytes('€€', 5)).toBe(true)
})

test('rowKey keeps the provider: a short id shared by two providers resolves to none', () => {
  expect(rowKey(later, 'p/m')).toBe('p/m')
  expect(rowKey(later, 'm')).toBeNull()
  expect(rowKey(later, 'other')).toBe('r/other')
  expect(rowKey(later, 'nothing')).toBeNull()
  expect(rowKey(later, undefined)).toBeNull()
})

test('runs whose models resolve to different rows are never grouped, even with the same short id', () => {
  const shares = planShares('f', [measured('a', 'p/m'), measured('b', 'q/m')], [], later, 300)
  expect(shares.length).toBe(2)
  expect(shareOf(shares, 'a').sharedKey).toBeUndefined()
  expect(shareOf(shares, 'b').sharedKey).toBeUndefined()
  expect(shareOf(shares, 'a').usage).toEqual(used(10))
  expect(shareOf(shares, 'a').cost).toBe(1)
  expect(shareOf(shares, 'b').usage).toEqual(used(20))
  expect(shareOf(shares, 'b').cost).toBe(2)
  expect(shareOf(shares, 'a').approx).toBe(false)
  expect(shareOf(shares, 'b').approx).toBe(false)
})

test('a full key and a short id that resolve to the same row group together', () => {
  const snap = shot(200, 2, { 'p/m': fig(10, 1) })
  const base = shot(100, 1, { 'p/m': fig(0) })
  const shares = planShares('f', [measured('a', 'p/m', { base }), measured('b', 'm', { base })], [], snap, 300)
  expect(shareOf(shares, 'a').sharedSize).toBe(2)
  expect(shareOf(shares, 'b').sharedKey).toBe(shareOf(shares, 'a').sharedKey)
  expect(shareOf(shares, 'a').usage).toEqual(used(10))
})

test('a run that names no row gets the project total less the rows the other runs have, approximate', () => {
  const shot2 = shot(200, 2, { 'p/m': fig(10, 1), 'r/other': fig(20, 2) })
  const base = shot(100, 1, { 'p/m': fig(0), 'r/other': fig(0) })
  const shares = planShares('f', [measured('known', 'p/m', { base }), measured('alias', 'some-alias', { base })], [], shot2, 300)
  expect(shareOf(shares, 'known').usage).toEqual(used(10))
  expect(shareOf(shares, 'known').approx).toBe(false)
  expect(shareOf(shares, 'alias').usage).toEqual(used(20))
  expect(shareOf(shares, 'alias').cost).toBe(2)
  expect(shareOf(shares, 'alias').approx).toBe(true)
  // together: the physical total, once
  expect(shareOf(shares, 'known').usage.uncached + shareOf(shares, 'alias').usage.uncached).toBe(30)
})

test('a run alone on the project total is approximate; unresolved runs group with each other only', () => {
  const alone = planShares('f', [measured('x', undefined)], [], later, 300)
  expect(shareOf(alone, 'x').usage).toEqual(used(30))
  expect(shareOf(alone, 'x').approx).toBe(true)
  const two = planShares('f', [measured('x', undefined), measured('y', 'alias')], [], later, 300)
  expect(shareOf(two, 'x').sharedSize).toBe(2)
  expect(shareOf(two, 'y').sharedKey).toBe(shareOf(two, 'x').sharedKey)
})

test('an exact member is taken out of the group it overlaps, clamped, and the rest is approximate', () => {
  const snap = shot(200, 2, { 'p/m': fig(100, 3) })
  const base = shot(100, 1, { 'p/m': fig(0) })
  const exact = { id: 'e', model: 'p/m', startedAt: 100, endedAt: undefined, usage: used(40), cost: 1 }
  const shares = planShares('f', [measured('a', 'p/m', { base })], [exact], snap, 300)
  expect(shares.length).toBe(1)
  expect(shares[0]!.usage).toEqual(used(60))
  expect(shares[0]!.cost).toBe(2)
  expect(shares[0]!.approx).toBe(true)
  expect(shares[0]!.sharedKey).toBeUndefined()
  const huge = { ...exact, usage: used(500), cost: 9 }
  const clamped = planShares('f', [measured('a', 'p/m', { base })], [huge], snap, 300)
  expect(clamped[0]!.usage).toEqual(zero)
  expect(clamped[0]!.cost).toBe(0)
})

test('a later group of the same folder and row has its own key; a joining run does not move its group key', () => {
  const snap = shot(900, 2, { 'p/m': fig(10, 1) })
  const base = shot(100, 1, { 'p/m': fig(0) })
  const run = (id: string, startedAt: number, endedAt?: number) => measured(id, 'p/m', { base, startedAt, endedAt })
  const first = planShares('f', [run('a', 100, 300), run('b', 150, 300), run('c', 500, 800), run('d', 520, 800)], [], snap, 1000)
  const key = (id: string) => shareOf(first, id).sharedKey
  expect(key('a')).toBe(key('b'))
  expect(key('c')).toBe(key('d'))
  expect(key('a')).not.toBe(key('c'))
  // a third run joins the first group: the earliest start, so the key, stays
  const joined = planShares('f', [run('a', 100, 300), run('b', 150, 300), run('e', 200, 300), run('c', 500, 800), run('d', 520, 800)], [], snap, 1000)
  expect(shareOf(joined, 'e').sharedSize).toBe(3)
  expect(shareOf(joined, 'a').sharedKey).toBe(key('a'))
})

test('a group with no live member is not planned', () => {
  const run = measured('a', 'p/m', { live: false, endedAt: 150 })
  expect(planShares('f', [run], [], later, 300)).toEqual([])
})

test('a base taken late marks the figure approximate, and more new sessions than runs does too', () => {
  const late = planShares('f', [measured('a', 'p/m', { baseApprox: true })], [], later, 300)
  expect(shareOf(late, 'a').approx).toBe(true)
  const crowded = shot(200, 9, { 'p/m': fig(10, 1) })
  expect(shareOf(planShares('f', [measured('a', 'p/m', { base: shot(100, 1, { 'p/m': fig(0) }) })], [], crowded, 300), 'a').approx).toBe(true)
})

test('holdUp keeps a field that fell and marks it held; a new basis starts over', () => {
  const last = { usage: used(50), cost: 0.5, basis: 'b' }
  const fell = holdUp(last, used(40), 0.4, 'b')
  expect(fell.usage).toEqual(used(50))
  expect(fell.cost).toBe(0.5)
  expect(fell.held).toBe(true)
  const rose = holdUp(last, used(60), 0.6, 'b')
  expect(rose.usage).toEqual(used(60))
  expect(rose.held).toBe(false)
  expect(holdUp(last, used(10), 0.1, 'other').usage).toEqual(used(10))
  expect(holdUp(undefined, used(10), 0.1, 'b').held).toBe(false)
  // through the plan: the second look is lower than the first
  const first = planShares('f', [measured('a', 'p/m')], [], later, 300)[0]!
  const dip = shot(210, 2, { 'p/m': fig(4, 0.4), 'q/m': fig(0), 'r/other': fig(0) })
  const second = planShares('f', [measured('a', 'p/m', { last: { usage: first.usage, cost: first.cost, basis: first.basis } })], [], dip, 300)[0]!
  expect(second.usage).toEqual(used(10))
  expect(second.approx).toBe(true)
})

test('capped drops the oldest entries of a Map or a Set down to the cap', () => {
  const map = new Map<string, number>()
  const set = new Set<string>()
  for (let i = 0; i < 300; i++) {
    map.set(`k${i}`, i)
    set.add(`k${i}`)
  }
  capped(map, 256)
  capped(set, 256)
  expect(map.size).toBe(256)
  expect(set.size).toBe(256)
  expect(map.has('k43')).toBe(false)
  expect(map.has('k44')).toBe(true)
  expect(set.has('k299')).toBe(true)
  capped(map, 400)
  expect(map.size).toBe(256)
})

test('a snapshot serves as a baseline when taken at or before the start (not older than a poll) or after it', () => {
  const taken = (at: number, from: number) => ({ snap: { at }, from })
  expect(baselineFrom(1000, taken(900, 800))).toEqual({ approx: false })
  expect(baselineFrom(1000, taken(1000, 900))).toEqual({ approx: false })
  expect(baselineFrom(1000, taken(1000 - STATS_EVERY_MS - 1, 0))).toBeNull()
  // after the start: exact enough when its process began right away, approximate otherwise
  expect(baselineFrom(1000, taken(1200, 1100))).toEqual({ approx: false })
  expect(baselineFrom(1000, taken(9000, 1000 + STATS_RACE_MS + 1))).toEqual({ approx: true })
  expect(baselineFrom(1000, taken(1200, 900))).toEqual({ approx: true })
})

test('chainByOverlap chains ranges that meet through a third', () => {
  const sets = chainByOverlap([[0, 5], [4, 10], [9, 12], [20, 30]] as const, r => r)
  expect(sets.map(s => s.length)).toEqual([3, 1])
})
