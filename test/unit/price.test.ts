import { expect, test } from 'claude-code/testing'

import type { Usage } from '../../types'
import { addUsage, estimateCost, litellmRates, normalizeModel, PRICES, ratesForAny, usageFromApi, withOverrides } from '../../src/price'

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
  // (was openai/gpt-6.1-sol: the LiteLLM snapshot now prices that one, see the lookup tests below)
  expect(estimateCost({ uncached: 1000, output: 0, cacheRead: 0, cacheWrite: 0 }, 'openai/no-such-model-0', PRICES)).toBeNull()
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

// ---- LiteLLM lookup (a tiny injected table, so the bundled snapshot does not matter)

const T = (rate: number): readonly [number, number, number, number] => [rate, rate * 2, rate / 10, rate * 1.25]
const rates = (rate: number) => ({ input: rate, output: rate * 2, cacheRead: rate / 10, cacheWrite: rate * 1.25 })

test('litellmRates: the key as given comes first', () => {
  const table = { 'openai/m': T(1), 'm': T(2), 'azure/m': T(3) }
  expect(litellmRates('openai/m', undefined, table)).toEqual(rates(1))
})

test('litellmRates: then provider/id with the known provider, then the bare id, then the fixed provider order', () => {
  // (b) the provider given comes after the key as given and before the bare id
  expect(litellmRates('x/m', 'groq', { 'groq/m': T(1), 'm': T(2), 'openai/m': T(3) })).toEqual(rates(1))
  expect(litellmRates('x/m', 'groq', { 'x/m': T(4), 'groq/m': T(1) })).toEqual(rates(4))
  // (c) a provider/id the table lacks falls to the bare id
  expect(litellmRates('github-copilot/m', undefined, { 'm': T(2), 'openai/m': T(3) })).toEqual(rates(2))
  // (d) the order is fixed: openai before anthropic before azure_ai
  expect(litellmRates('gh/m', undefined, { 'azure_ai/m': T(9), 'anthropic/m': T(5), 'gemini/m': T(7) })).toEqual(rates(5))
  expect(litellmRates('gh/m', undefined, { 'azure_ai/m': T(9), 'bedrock/m': T(4) })).toEqual(rates(9))
  expect(litellmRates('gh/m', undefined, { 'bedrock/m': T(4), 'fireworks_ai/m': T(6) })).toEqual(rates(4))
  // (e) nothing else matches: no substring or fuzzy match
  expect(litellmRates('gh/m', undefined, { 'openai/m-mini': T(1), 'xm': T(2), 'mistralai/m': T(3) })).toBeNull()
})

test('litellmRates: lower-cases, drops [1m] and an @variant, and is safe for odd names', () => {
  const table = { 'openai/m': T(1) }
  expect(litellmRates('OpenAI/M@xhigh', undefined, table)).toEqual(rates(1))
  expect(litellmRates('openai/m[1m]', undefined, table)).toEqual(rates(1))
  expect(litellmRates('', undefined, table)).toBeNull()
  expect(litellmRates('openai/', undefined, table)).toBeNull()
  expect(litellmRates('__proto__', undefined, table)).toBeNull()
  expect(litellmRates('constructor', undefined, table)).toBeNull()
})

test('litellmRates: a model the used provider does not list is priced by its maker', () => {
  // a reseller provider: the maker's entry wins over an entry in the generic provider order
  expect(litellmRates('opencode-go/glm-5.3', 'opencode-go', { 'zai/glm-5.3': T(1), 'azure_ai/glm-5.3': T(2) })).toEqual(rates(1))
  expect(litellmRates('opencode-go/kimi-k3', undefined, { 'moonshot/kimi-k3': T(1), 'fireworks_ai/kimi-k3': T(2) })).toEqual(rates(1))
  expect(litellmRates('opencode-go/qwen3.8-max', undefined, { 'dashscope/qwen3.8-max': T(3) })).toEqual(rates(3))
  // the key as given, provider/id and the bare id all beat the maker
  expect(litellmRates('opencode-go/glm-5.3', undefined, { 'opencode-go/glm-5.3': T(4), 'zai/glm-5.3': T(1) })).toEqual(rates(4))
  expect(litellmRates('x/glm-5.3', 'groq', { 'groq/glm-5.3': T(5), 'zai/glm-5.3': T(1) })).toEqual(rates(5))
  expect(litellmRates('opencode-go/glm-5.3', undefined, { 'glm-5.3': T(6), 'zai/glm-5.3': T(1) })).toEqual(rates(6))
  // a name no maker claims falls to the provider order as before
  expect(litellmRates('gh/other-1', undefined, { 'zai/other-1': T(1), 'azure_ai/other-1': T(2) })).toEqual(rates(2))
})

test('litellmRates: the bare name after the last slash, then its maker', () => {
  expect(litellmRates('openrouter/openai/gpt-6-sol', undefined, { 'gpt-6-sol': T(1) })).toEqual(rates(1))
  expect(litellmRates('openrouter/moonshotai/kimi-k3', undefined, { 'moonshot/kimi-k3': T(1), 'fireworks_ai/kimi-k3': T(2) })).toEqual(rates(1))
  // the id (after the first slash) still comes before the name
  expect(litellmRates('openrouter/openai/gpt-6-sol', undefined, { 'openai/gpt-6-sol': T(2), 'gpt-6-sol': T(1) })).toEqual(rates(2))
})

test('litellmRates: upper case and an @variant still reach the maker', () => {
  expect(litellmRates('OpenCode-Go/GLM-5.3@high', undefined, { 'zai/glm-5.3': T(1) })).toEqual(rates(1))
})

test('openai/gpt-6.1-sol resolves through the provider order to azure_ai only when openai/ and the bare id are absent', () => {
  const sol = { 'azure_ai/gpt-6.1-sol': T(2) }
  expect(litellmRates('openai/gpt-6.1-sol', undefined, sol)).toEqual(rates(2))
  expect(litellmRates('openai/gpt-6.1-sol', undefined, { ...sol, 'gpt-6.1-sol': T(1) })).toEqual(rates(1))
  expect(litellmRates('openai/gpt-6.1-sol', undefined, { ...sol, 'openai/gpt-6.1-sol': T(3) })).toEqual(rates(3))
})

test('the bundled snapshot is the default table', () => {
  expect(litellmRates('azure_ai/gpt-6.1-sol')).not.toBeNull()
  expect(estimateCost({ uncached: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 }, 'openai/gpt-6.1-sol', PRICES)).not.toBeNull()
})

test('Claude ids keep the Claude table over LiteLLM, and overrides beat both', () => {
  const litellm = { 'claude-sonnet-5-5': [2, 10, 0.1, 99] as const } // the Claude table says cacheRead 0.2, cacheWrite 2.5
  expect(ratesForAny('claude-sonnet-5-5', 0, PRICES, litellm)).toEqual(PRICES['claude-sonnet-5-5'])
  near(estimateCost({ uncached: 0, output: 0, cacheRead: 1_000_000, cacheWrite: 0 }, 'claude-sonnet-5-5', PRICES, litellm), 0.2)
  const own = withOverrides(PRICES, JSON.stringify({ 'claude-sonnet-5-5': { input: 7, output: 7, cacheRead: 7, cacheWrite: 7 }, 'openai/m': { input: 5, output: 5, cacheRead: 5, cacheWrite: 5 } }))
  expect(ratesForAny('claude-sonnet-5-5', 0, own, litellm)).toEqual({ input: 7, output: 7, cacheRead: 7, cacheWrite: 7 })
  expect(ratesForAny('openai/m', 0, own, { 'openai/m': T(1) })).toEqual({ input: 5, output: 5, cacheRead: 5, cacheWrite: 5 })
})

test('the haiku long tier still applies, and a model only LiteLLM knows is priced by it', () => {
  near(estimateCost({ uncached: 200_000, output: 0, cacheRead: 0, cacheWrite: 0 }, 'claude-haiku-5-5', PRICES, {}), 0.1)
  near(estimateCost({ uncached: 1_000_000, output: 1_000_000, cacheRead: 0, cacheWrite: 0 }, 'other/x', PRICES, { 'other/x': T(1) }), 3)
  expect(estimateCost({ uncached: 1, output: 0, cacheRead: 0, cacheWrite: 0 }, 'other/x', PRICES, {})).toBeNull()
})
