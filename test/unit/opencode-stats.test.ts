import { expect, test } from 'claude-code/testing'

import {
  allocate,
  exceedsBytes,
  MAX_STATS_MODELS,
  projectStats,
  rowKey,
  STATS_ARGV,
  type FolderRun,
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

// ---- allocate: the growth between two snapshots, split among the runs active in the interval

const ofRun = (id: string, model: string | undefined, startedAt: number, endedAt?: number): FolderRun => ({ id, model, startedAt, endedAt })
const grant = (list: ReturnType<typeof allocate>, id: string) => list.find(a => a.id === id)!
const money = (a: number, b: number): boolean => Math.abs(a - b) < 1e-9

test('allocate: two runs of different models in one folder each get exactly their row growth, not approximate', () => {
  const prev = shot(100, 1, { 'p/m': fig(0), 'r/other': fig(0) })
  const cur = shot(200, 3, { 'p/m': fig(10, 1), 'r/other': fig(20, 2) })
  const out = allocate(prev, cur, [ofRun('a', 'p/m', 100), ofRun('b', 'other', 100)])
  expect(out.length).toBe(2)
  expect(grant(out, 'a').usage).toEqual(used(10))
  expect(grant(out, 'a').cost).toBe(1)
  expect(grant(out, 'b').usage).toEqual(used(20))
  expect(grant(out, 'b').cost).toBe(2)
  for (const id of ['a', 'b']) {
    expect(grant(out, id).shared).toBe(1)
    expect(grant(out, id).approx).toBe(false)
  }
})

test('allocate: two overlapping same-model runs split 101 tokens and $3 as 51 + 50 and $1.5 each, shared 2, approximate', () => {
  const prev = shot(100, 1, { 'p/m': fig(0) })
  const cur = shot(200, 3, { 'p/m': fig(101, 3) })
  const out = allocate(prev, cur, [ofRun('b', 'p/m', 120), ofRun('a', 'p/m', 110)])
  // the remainder goes to the earlier start
  expect(grant(out, 'a').usage).toEqual(used(51))
  expect(grant(out, 'b').usage).toEqual(used(50))
  expect(grant(out, 'a').cost).toBe(1.5)
  expect(grant(out, 'b').cost).toBe(1.5)
  for (const id of ['a', 'b']) {
    expect(grant(out, id).shared).toBe(2)
    expect(grant(out, id).approx).toBe(true)
  }
  expect(grant(out, 'a').usage.uncached + grant(out, 'b').usage.uncached).toBe(101)
})

test('allocate: reasoning joins output, the remainder of every field is spread, and the shares sum to the growth', () => {
  const prev = shot(100, 1, { 'p/m': fig(0) })
  const cur: StatsSnapshot = {
    at: 200,
    sessions: 3,
    total: { input: 7, output: 5, reasoning: 4, cacheRead: 11, cacheWrite: 3, cost: 0.9 },
    models: { 'p/m': { input: 7, output: 5, reasoning: 4, cacheRead: 11, cacheWrite: 3, cost: 0.9 } },
  }
  const runs = [ofRun('a', 'p/m', 100), ofRun('b', 'p/m', 101), ofRun('c', 'p/m', 102)]
  const out = allocate(prev, cur, runs)
  const sum = (field: 'uncached' | 'output' | 'cacheRead' | 'cacheWrite') => out.reduce((s, a) => s + a.usage[field], 0)
  expect(sum('uncached')).toBe(7)
  expect(sum('output')).toBe(9)
  expect(sum('cacheRead')).toBe(11)
  expect(sum('cacheWrite')).toBe(3)
  expect(money(out.reduce((s, a) => s + a.cost, 0), 0.9)).toBe(true)
  expect(grant(out, 'a').usage).toEqual({ uncached: 3, output: 4, cacheRead: 4, cacheWrite: 1 })
})

test('allocate: sequential runs on one model split the interval they meet in, and over three intervals the two sum to the growth', () => {
  // A runs to 150, B starts at 160; the second interval (200, 300] holds the end of A's tail and B's start
  const s0 = shot(100, 1, { 'p/m': fig(0, 0) })
  const s1 = shot(200, 2, { 'p/m': fig(60, 6) })
  const s2 = shot(300, 3, { 'p/m': fig(100, 10) })
  const s3 = shot(400, 3, { 'p/m': fig(190, 19) })
  const a = ofRun('a', 'p/m', 100, 250)
  const b = ofRun('b', 'p/m', 260)
  let usage = { a: 0, b: 0 }
  let cost = { a: 0, b: 0 }
  const second = allocate(s1, s2, [a, b])
  // both are active in (200, 300]: even split of 40 tokens
  expect(grant(second, 'a').usage.uncached).toBe(20)
  expect(grant(second, 'b').usage.uncached).toBe(20)
  for (const [prev, cur] of [[s0, s1], [s1, s2], [s2, s3]] as const) {
    for (const g of allocate(prev, cur, [a, b])) {
      const key = g.id as 'a' | 'b'
      usage = { ...usage, [key]: usage[key] + g.usage.uncached }
      cost = { ...cost, [key]: cost[key] + g.cost }
    }
  }
  // A is not active in (300, 400]: it ended at 250 < 300, so B alone takes the last 90
  expect(usage.a + usage.b).toBe(190)
  expect(money(cost.a + cost.b, 19)).toBe(true)
  expect(usage.a).toBe(60 + 20)
  expect(usage.b).toBe(20 + 90)
})

test('allocate: an unknown-model run beside a known one gets the project total less the known row; the known run gets its row', () => {
  const prev = shot(100, 1, { 'p/m': fig(0), 'r/other': fig(0) })
  const cur = shot(200, 3, { 'p/m': fig(10, 1), 'r/other': fig(20, 2) })
  const out = allocate(prev, cur, [ofRun('known', 'p/m', 100), ofRun('alias', 'some-alias', 100)])
  expect(grant(out, 'known').usage).toEqual(used(10))
  expect(grant(out, 'known').approx).toBe(false)
  expect(grant(out, 'alias').usage).toEqual(used(20))
  expect(grant(out, 'alias').cost).toBe(2)
  expect(grant(out, 'known').usage.uncached + grant(out, 'alias').usage.uncached).toBe(30)
})

test('allocate: a run with no model takes the whole project growth when it is alone', () => {
  const prev = shot(100, 1, { 'p/m': fig(0), 'q/m': fig(0) })
  const cur = shot(200, 2, { 'p/m': fig(10, 1), 'q/m': fig(20, 2) })
  const out = allocate(prev, cur, [ofRun('x', undefined, 100)])
  expect(grant(out, 'x').usage).toEqual(used(30))
  expect(grant(out, 'x').cost).toBe(3)
  expect(grant(out, 'x').shared).toBe(1)
})

test('allocate: growth of a row no active run names is dropped, not handed to the others', () => {
  // r/other grew by 20 but no run uses it: nobody receives it, and the p/m run gets only its own row
  const prev = shot(100, 1, { 'p/m': fig(0), 'r/other': fig(0) })
  const cur = shot(200, 2, { 'p/m': fig(10, 1), 'r/other': fig(20, 2) })
  const out = allocate(prev, cur, [ofRun('a', 'p/m', 100)])
  expect(out.length).toBe(1)
  expect(grant(out, 'a').usage).toEqual(used(10))
  expect(grant(out, 'a').cost).toBe(1)
})

test('allocate: a counter that went down is 0 for this interval and approximate; the next interval measures from the new value', () => {
  const prev = shot(100, 1, { 'p/m': fig(500, 5) })
  const dip = shot(200, 2, { 'p/m': fig(300, 3) })
  const after = shot(300, 2, { 'p/m': fig(350, 3.5) })
  const first = allocate(prev, dip, [ofRun('a', 'p/m', 100)])
  expect(grant(first, 'a').usage).toEqual(used(0))
  expect(grant(first, 'a').cost).toBe(0)
  expect(grant(first, 'a').approx).toBe(true)
  const second = allocate(dip, after, [ofRun('a', 'p/m', 100)])
  expect(grant(second, 'a').usage).toEqual(used(50))
  expect(money(grant(second, 'a').cost, 0.5)).toBe(true)
  expect(grant(second, 'a').approx).toBe(false)
})

test('allocate: a reasoning counter that fell alone marks approximate and the other fields still count', () => {
  const prev: StatsSnapshot = { at: 100, sessions: 1, total: { ...fig(1), reasoning: 9 }, models: {} }
  const cur: StatsSnapshot = { at: 200, sessions: 2, total: { ...fig(2), output: 3, reasoning: 4 }, models: {} }
  const out = allocate(prev, cur, [ofRun('a', undefined, 100)])
  expect(grant(out, 'a').approx).toBe(true)
  expect(grant(out, 'a').usage).toEqual({ uncached: 1, output: 3, cacheRead: 0, cacheWrite: 0 })
})

test('allocate: more new sessions than active runs marks every run approximate', () => {
  const prev = shot(100, 1, { 'p/m': fig(0) })
  const crowded = shot(200, 9, { 'p/m': fig(10, 1) })
  expect(grant(allocate(prev, crowded, [ofRun('a', 'p/m', 100)]), 'a').approx).toBe(true)
  const fine = shot(200, 2, { 'p/m': fig(10, 1) })
  expect(grant(allocate(prev, fine, [ofRun('a', 'p/m', 100)]), 'a').approx).toBe(false)
})

test('allocate: a run that ended before the interval opened, or started after it closed, gets nothing', () => {
  const prev = shot(100, 1, { 'p/m': fig(0) })
  const cur = shot(200, 2, { 'p/m': fig(10, 1) })
  const out = allocate(prev, cur, [ofRun('gone', 'p/m', 10, 99), ofRun('here', 'p/m', 50, 100), ofRun('late', 'p/m', 201), ofRun('open', 'p/m', 200)])
  expect(out.map(a => a.id).sort()).toEqual(['here', 'open'])
  // 'gone' and 'late' do not take part in the split either
  expect(grant(out, 'here').shared).toBe(2)
  expect(grant(out, 'here').usage.uncached + grant(out, 'open').usage.uncached).toBe(10)
})

test('allocate: a row that did not exist at the earlier snapshot counts from zero; no runs, no allocations', () => {
  const prev = shot(100, 1, {})
  const cur = shot(200, 2, { 'p/m': fig(7, 0.4) })
  const out = allocate(prev, cur, [ofRun('a', 'p/m', 100)])
  expect(grant(out, 'a').usage).toEqual(used(7))
  expect(grant(out, 'a').approx).toBe(false)
  expect(allocate(prev, cur, [])).toEqual([])
})

test('allocate: runs whose models resolve to different rows are never split together, even with the same short id', () => {
  const prev = shot(100, 1, { 'p/m': fig(0), 'q/m': fig(0) })
  const cur = shot(200, 3, { 'p/m': fig(10, 1), 'q/m': fig(20, 2) })
  const out = allocate(prev, cur, [ofRun('a', 'p/m', 100), ofRun('b', 'q/m', 100), ofRun('amb', 'm', 100)])
  expect(grant(out, 'a').usage).toEqual(used(10))
  expect(grant(out, 'b').usage).toEqual(used(20))
  // 'm' names two rows: it is unresolved and takes the residual, which is nothing here
  expect(grant(out, 'amb').usage).toEqual(used(0))
})
