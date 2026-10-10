import { expect, test } from 'claude-code/testing'

import type { Usage } from '../../types'
import { addUsage, estimateCost, normalizeModel, PRICES, usageFromApi, withOverrides } from '../../src/price'

function near(a: number | null | undefined, b: number): void {
  expect(typeof a === 'number' && Math.abs(a - b) < 1e-9).toBe(true)
}

test('normalizeModel strips [1m], date, Vertex and Bedrock affixes and lower-cases', () => {
  expect(normalizeModel('claude-opus-5-5')).toBe('claude-opus-5-5')
  expect(normalizeModel('claude-opus-5-5[1m]')).toBe('claude-opus-5-5')
  expect(normalizeModel('claude-sonnet-4-6-20260115')).toBe('claude-sonnet-4-6')
  expect(normalizeModel('anthropic.claude-opus-5-5')).toBe('claude-opus-5-5')
  expect(normalizeModel('claude-opus-4-5@20251101')).toBe('claude-opus-4-5')
  expect(normalizeModel('CLAUDE-HAIKU-5-5')).toBe('claude-haiku-5-5')
})

test('estimateCost prices opus-5-5 per million tokens', () => {
  const cost = (u: Usage) => estimateCost(u, 'claude-opus-5-5', PRICES)
  near(cost({ uncached: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 }), 4)
  near(cost({ uncached: 0, output: 1_000_000, cacheRead: 0, cacheWrite: 0 }), 20)
  near(cost({ uncached: 0, output: 0, cacheRead: 1_000_000, cacheWrite: 0 }), 0.2)
  near(cost({ uncached: 0, output: 0, cacheRead: 0, cacheWrite: 1_000_000 }), 5)
})

test('estimateCost haiku-5-5 uses the short tier, and the long tier above 100k input', () => {
  near(estimateCost({ uncached: 50_000, output: 1000, cacheRead: 0, cacheWrite: 0 }, 'claude-haiku-5-5', PRICES), 0.0055)
  near(estimateCost({ uncached: 60_000, output: 0, cacheRead: 50_000, cacheWrite: 0 }, 'claude-haiku-5-5', PRICES), 0.0325)
})

test('unknown models have no estimate; the [1m] tag is ignored', () => {
  expect(estimateCost({ uncached: 1000, output: 0, cacheRead: 0, cacheWrite: 0 }, 'openai/gpt-6.1-sol', PRICES)).toBeNull()
  near(estimateCost({ uncached: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 }, 'claude-opus-5-5[1m]', PRICES), 4)
})

test('withOverrides merges valid entries and ignores invalid JSON and negative rates', () => {
  const merged = withOverrides(PRICES, '{"my-model":{"input":1,"output":2,"cacheRead":0.1,"cacheWrite":1.25}}')
  expect(merged['my-model']).toEqual({ input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 })
  expect(withOverrides(PRICES, 'not json')).toEqual(PRICES)
  expect(withOverrides(PRICES, '{"x":{"input":-1,"output":1,"cacheRead":0,"cacheWrite":0}}')['x']).toBeUndefined()
})

const FREE = { output: 0, cacheRead: 0, cacheWrite: 0 }

test('withOverrides: an @long key overrides the long tier only', () => {
  const merged = withOverrides(PRICES, JSON.stringify({ 'claude-haiku-5-5@long': { input: 9, ...FREE } }))
  near(estimateCost({ uncached: 200_000, output: 0, cacheRead: 0, cacheWrite: 0 }, 'claude-haiku-5-5', merged), 1.8)
  near(estimateCost({ uncached: 50_000, output: 0, cacheRead: 0, cacheWrite: 0 }, 'claude-haiku-5-5', merged), 0.005)
})

test('withOverrides: a base haiku override applies to both tiers unless @long is given', () => {
  const only = withOverrides(PRICES, JSON.stringify({ 'claude-haiku-5-5': { input: 2, ...FREE } }))
  near(estimateCost({ uncached: 200_000, output: 0, cacheRead: 0, cacheWrite: 0 }, 'claude-haiku-5-5', only), 0.4)
  near(estimateCost({ uncached: 50_000, output: 0, cacheRead: 0, cacheWrite: 0 }, 'claude-haiku-5-5', only), 0.1)
  const both = withOverrides(
    PRICES,
    JSON.stringify({ 'claude-haiku-5-5@long': { input: 9, ...FREE }, 'claude-haiku-5-5': { input: 2, ...FREE } }),
  )
  near(estimateCost({ uncached: 200_000, output: 0, cacheRead: 0, cacheWrite: 0 }, 'claude-haiku-5-5', both), 1.8)
  near(estimateCost({ uncached: 50_000, output: 0, cacheRead: 0, cacheWrite: 0 }, 'claude-haiku-5-5', both), 0.1)
})

test('usageFromApi maps the four API fields and addUsage sums fieldwise', () => {
  const u = usageFromApi({ input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 })
  expect(u).toEqual({ uncached: 1, output: 2, cacheRead: 3, cacheWrite: 4 })
  expect(addUsage(u, { uncached: 10, output: 20, cacheRead: 30, cacheWrite: 40 })).toEqual({ uncached: 11, output: 22, cacheRead: 33, cacheWrite: 44 })
})
