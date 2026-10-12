import { expect, test } from 'claude-code/testing'

import { attribute, MAX_STATS_MODELS, projectStats, STATS_ARGV } from '../../src/adapters/opencode-stats'

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
