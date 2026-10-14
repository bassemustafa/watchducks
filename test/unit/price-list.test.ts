import { expect, test } from 'claude-code/testing'

import type { Run } from '../../types'
import { shownCost } from '../../src/cost'
import {
  LITELLM_URL,
  PRICES,
  PRICES_KEY,
  estimateDetail,
  fetchedPrices,
  parsePriceRecord,
  pricedBy,
  projectLitellm,
  withOverrides,
} from '../../src/price'
import { LITELLM, LITELLM_DATE } from '../../src/prices-litellm'
import { runCost } from '../../src/ui/dossier'

// The fixture the generator is checked against by hand (node scripts/update-prices.mjs --from <this>): 120 plain chat models
// plus one entry per rule. `projectLitellm` and the generator must give the same table.
function fixture(): Record<string, unknown> {
  const list: Record<string, unknown> = {}
  for (let i = 0; i < 120; i++) list[`pad-${i}`] = { mode: 'chat', input_cost_per_token: 1e-6 }
  return {
    ...list,
    sample_spec: { mode: 'chat', input_cost_per_token: 0 },
    'Azure_AI/GPT-6.1-Sol': {
      mode: 'chat',
      input_cost_per_token: 2e-6,
      output_cost_per_token: 1e-5,
      cache_read_input_token_cost: 1e-7,
      cache_creation_input_token_cost: 2.5e-6,
      input_cost_per_token_above_200k_tokens: 9,
      litellm_provider: 'azure_ai',
    },
    'openai/gpt-x': { mode: 'chat', input_cost_per_token: 1.5e-7, output_cost_per_token: 6e-7 },
    'openai/gpt-x-mini': { mode: 'chat', input_cost_per_token: 1.5e-7, output_cost_per_token: 6e-7, cache_read_input_token_cost: 0 },
    'embed-1': { mode: 'embedding', input_cost_per_token: 1e-7 },
    'no-input': { mode: 'chat', output_cost_per_token: 1e-6 },
    neg: { mode: 'chat', input_cost_per_token: -1 },
    huge: { mode: 'chat', input_cost_per_token: 1 },
    'huge-out': { mode: 'chat', input_cost_per_token: 1e-6, output_cost_per_token: 0.5 },
    'str-rate': { mode: 'chat', input_cost_per_token: '1e-6' },
    'bad key!': { mode: 'chat', input_cost_per_token: 1e-6 },
    ['k'.repeat(161)]: { mode: 'chat', input_cost_per_token: 1e-6 },
    ['__proto__']: { mode: 'chat', input_cost_per_token: 1e-6 },
    'not-an-object': 'chat',
    'null-entry': null,
  }
}

const project = (list: unknown): Record<string, readonly number[]> | null => projectLitellm(JSON.stringify(list))

test('projectLitellm: chat models with a numeric input rate, per million, six decimals, missing cache rates 0', () => {
  const out = project(fixture())!
  expect(out['azure_ai/gpt-6.1-sol']).toEqual([2, 10, 0.1, 2.5])
  expect(out['openai/gpt-x']).toEqual([0.15, 0.6, 0, 0])
  expect(out['openai/gpt-x-mini']).toEqual([0.15, 0.6, 0, 0])
  expect(out['pad-0']).toEqual([1, 0, 0, 0])
  expect(Object.keys(out).length).toBe(123)
})

test('projectLitellm: non-chat, missing input, bad numbers, bad keys and the placeholders are skipped', () => {
  const out = project(fixture())!
  for (const key of ['sample_spec', 'embed-1', 'no-input', 'neg', 'huge', 'huge-out', 'str-rate', 'bad key!', 'not-an-object', 'null-entry']) {
    expect(Object.hasOwn(out, key)).toBe(false)
  }
  expect(Object.hasOwn(out, 'k'.repeat(161))).toBe(false)
  expect(Object.hasOwn(out, '__proto__')).toBe(false)
  expect(Object.getPrototypeOf(out)).toBe(Object.prototype)
})

test('projectLitellm: the first spelling of a lower-cased key wins; at most 6000 entries are kept', () => {
  const two = project({ ...fixture(), 'Dup/Model': { mode: 'chat', input_cost_per_token: 1e-6 }, 'dup/model': { mode: 'chat', input_cost_per_token: 5e-6 } })!
  expect(two['dup/model']).toEqual([1, 0, 0, 0])
  const many: Record<string, unknown> = {}
  for (let i = 0; i < 6100; i++) many[`m-${i}`] = { mode: 'chat', input_cost_per_token: 1e-6 }
  expect(Object.keys(project(many)!).length).toBe(6000)
})

test('projectLitellm: null for text over 8 MiB, text that is not JSON, not an object, or fewer than 100 entries', () => {
  expect(projectLitellm('<html>no</html>')).toBeNull()
  expect(projectLitellm('')).toBeNull()
  expect(projectLitellm('[1, 2, 3]')).toBeNull()
  expect(projectLitellm('7')).toBeNull()
  const few: Record<string, unknown> = {}
  for (let i = 0; i < 99; i++) few[`m-${i}`] = { mode: 'chat', input_cost_per_token: 1e-6 }
  expect(project(few)).toBeNull()
  few['m-99'] = { mode: 'chat', input_cost_per_token: 1e-6 }
  expect(project(few)).not.toBeNull()
  expect(projectLitellm(JSON.stringify({ ...fixture(), pad: 'x'.repeat(8 * 1024 * 1024 + 1) }))).toBeNull()
})

test('the one URL and the store key are fixed', () => {
  expect(LITELLM_URL).toBe('https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json')
  expect(PRICES_KEY).toBe('prices/litellm/v1')
})

// ---- the stored record

const good = { v: 1, fetchedAt: 5, attemptedAt: 6, rates: { 'a/b': [1, 2, 0, 0.5] } }

test('parsePriceRecord: a record that checks out is read; any other shape is null', () => {
  expect(parsePriceRecord(good)).toEqual(good)
  expect(parsePriceRecord({ ...good, rates: {} })).toEqual({ ...good, rates: {} })
  for (const bad of [
    undefined,
    null,
    'x',
    [],
    { ...good, v: 2 },
    { ...good, fetchedAt: -1 },
    { ...good, attemptedAt: '6' },
    { ...good, fetchedAt: Number.NaN },
    { ...good, rates: [] },
    { ...good, rates: null },
    { ...good, rates: { 'Upper/Case': [1, 2, 3, 4] } },
    { ...good, rates: { 'bad key': [1, 2, 3, 4] } },
    { ...good, rates: { 'a/b': [1, 2, 3] } },
    { ...good, rates: { 'a/b': [1, 2, 3, '4'] } },
    { ...good, rates: { 'a/b': [1, 2, 3, -4] } },
    { ...good, rates: { 'a/b': [1, 2, 3, 10_001] } },
  ]) {
    expect(parsePriceRecord(bad)).toBeNull()
  }
  const big: Record<string, number[]> = {}
  for (let i = 0; i < 6001; i++) big[`m-${i}`] = [1, 1, 1, 1]
  expect(parsePriceRecord({ ...good, rates: big })).toBeNull()
})

test('parsePriceRecord reads the four fields by name and copies the rates', () => {
  const rec = parsePriceRecord({ ...good, extra: 'SENTINEL', rates: { 'a/b': [1, 2, 0, 0.5] } })!
  expect(Object.keys(rec).sort()).toEqual(['attemptedAt', 'fetchedAt', 'rates', 'v'])
})

test('fetchedPrices: checks the rates once per fetchedAt, then answers from memory', () => {
  const read = fetchedPrices()
  const first = read(good)!
  expect(first.fetchedAt).toBe(5)
  expect(first.rates['a/b']).toEqual([1, 2, 0, 0.5])
  // a copy as the store hands it back: same fetchedAt, same answer
  expect(read({ ...good, rates: { 'a/b': [1, 2, 0, 0.5] } })).toBe(first)
  const later = read({ ...good, fetchedAt: 9, rates: { 'c/d': [3, 3, 3, 3] } })!
  expect(later.fetchedAt).toBe(9)
  expect(Object.keys(later.rates)).toEqual(['c/d'])
})

test('fetchedPrices: no record, an invalid one, no list yet, or a record gone all read as none', () => {
  const read = fetchedPrices()
  expect(read(undefined)).toBeUndefined()
  expect(read({ ...good, rates: { 'bad key': [1, 2, 3, 4] } })).toBeUndefined()
  expect(read({ ...good, fetchedAt: 0, rates: {} })).toBeUndefined()
  expect(read({ ...good, rates: {} })).toBeUndefined()
  expect(read(good)).not.toBeUndefined()
  expect(read(undefined)).toBeUndefined()
})

// ---- the order of the lists

const FETCHED = { 'zz-only/m': [7, 8, 9, 10] as const, 'claude-sonnet-5-5': [99, 99, 99, 99] as const, 'both/m': [50, 50, 50, 50] as const }
// a bundled key the lookup reaches as given (no @variant to strip)
const BUNDLED_KEY = Object.keys(LITELLM).find(k => /^[a-z0-9._:/+-]+$/.test(k))!
const BUNDLED = { 'both/m': [1, 1, 1, 1] as const, 'old/m': [2, 2, 2, 2] as const }

test('pricedBy: overrides and the Claude table, then the fetched list, then the bundled one', () => {
  const own = withOverrides(PRICES, JSON.stringify({ 'both/m': { input: 5, output: 5, cacheRead: 5, cacheWrite: 5 } }))
  expect(pricedBy('both/m', 0, own, BUNDLED, FETCHED)).toEqual({ rates: { input: 5, output: 5, cacheRead: 5, cacheWrite: 5 }, from: 'table' })
  expect(pricedBy('claude-sonnet-5-5', 0, PRICES, BUNDLED, FETCHED)!.from).toBe('table')
  expect(pricedBy('claude-sonnet-5-5', 0, PRICES, BUNDLED, FETCHED)!.rates).toEqual(PRICES['claude-sonnet-5-5'])
  expect(pricedBy('both/m', 0, PRICES, BUNDLED, FETCHED)).toEqual({ rates: { input: 50, output: 50, cacheRead: 50, cacheWrite: 50 }, from: 'fetched' })
  expect(pricedBy('zz-only/m', 0, PRICES, BUNDLED, FETCHED)!.from).toBe('fetched')
  expect(pricedBy('old/m', 0, PRICES, BUNDLED, FETCHED)).toEqual({ rates: { input: 2, output: 2, cacheRead: 2, cacheWrite: 2 }, from: 'bundled' })
  expect(pricedBy('old/m', 0, PRICES, BUNDLED)!.from).toBe('bundled')
  expect(pricedBy('nobody/m', 0, PRICES, BUNDLED, FETCHED)).toBeNull()
})

test('estimateDetail names the list; the bundled snapshot is the default fallback', () => {
  const usage = { uncached: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 }
  expect(estimateDetail(usage, 'zz-only/m', PRICES, BUNDLED, FETCHED)).toEqual({ cost: 7, from: 'fetched' })
  expect(estimateDetail(usage, 'old/m', PRICES, BUNDLED, FETCHED)).toEqual({ cost: 2, from: 'bundled' })
  const key = BUNDLED_KEY
  expect(estimateDetail(usage, key, {})!.from).toBe('bundled')
  expect(estimateDetail(usage, key, {}, {}, undefined)).toBeNull()
})

// ---- what a sink shows

const TOKENS = { uncached: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 }
const row = (model: string) => ({ cost: null, costSource: null, usage: TOKENS, model })

test('shownCost marks an estimate from the fetched or the bundled list, and none from the table', () => {
  expect(shownCost(row('zz-only/m'), 'auto', {}, FETCHED)).toEqual({ cost: 7, source: 'estimated', list: 'fetched' })
  const key = BUNDLED_KEY
  expect(shownCost(row(key), 'auto', {})).toEqual({ cost: LITELLM[key]![0], source: 'estimated', list: 'bundled' })
  expect(shownCost(row('own/m'), 'auto', { 'own/m': { input: 3, output: 0, cacheRead: 0, cacheWrite: 0 } }, FETCHED)).toEqual({
    cost: 3,
    source: 'estimated',
  })
  // a reported cost is no estimate: no list
  expect(shownCost({ ...row('zz-only/m'), cost: 2, costSource: 'reported' }, 'auto', {}, FETCHED)).toEqual({ cost: 2, source: 'reported' })
  // reported mode never estimates
  expect(shownCost(row('zz-only/m'), 'reported', {}, FETCHED)).toEqual({ cost: null, source: null })
})

test('shownCost over child rows reports the refreshed list when any row used it', () => {
  const run = { cost: null, costSource: null, usage: TOKENS, rows: [
    { implementer: 'opencode' as const, model: BUNDLED_KEY, usage: TOKENS, cost: null, costSource: null },
    { implementer: 'opencode' as const, model: 'zz-only/m', usage: TOKENS, cost: null, costSource: null },
  ] }
  expect(shownCost(run, 'auto', {}, FETCHED)).toEqual({ cost: LITELLM[BUNDLED_KEY]![0] + 7, source: 'estimated', list: 'fetched' })
  expect(shownCost(run, 'auto', {})).toEqual({ cost: LITELLM[BUNDLED_KEY]![0], source: 'estimated', partial: true, list: 'bundled' })
})

function aRun(model: string, over: Partial<Run> = {}): Run {
  return {
    id: 'r1', kind: 'agent', codename: 'TEAL-00', implementer: 'claude-code', readOnly: false, status: 'done', startedAt: 0,
    usage: TOKENS, usageSource: 'steps', cost: null, costSource: null, costPartial: false, editCalls: 0, bugsReported: 0,
    reviews: [], suspectedHandlers: [], model, ...over,
  }
}

test('runCost names the price list date for a LiteLLM estimate, shortening to fit and never cutting the figure', () => {
  const fetched = { table: {}, mode: 'auto' as const, fetched: FETCHED, fetchedAt: Date.UTC(2026, 9, 14, 23, 59) }
  const run = aRun('zz-only/m')
  expect(runCost(run, fetched, true)).toBe('$7.00 est. (LiteLLM prices of 2026-10-14)')
  expect(runCost(run, fetched, true, 34)).toBe('$7.00 est. (LiteLLM 2026-10-14)')
  expect(runCost(run, fetched, true, 24)).toBe('$7.00 est.')
  expect(runCost(run, fetched, true, 4)).toBe('$7.00 est.')
  // a card never carries the note
  expect(runCost(run, fetched)).toBe('$7.00 est.')
  // the bundled list: its own date
  const key = BUNDLED_KEY
  const bundled = { table: {}, mode: 'auto' as const }
  expect(runCost(aRun(key), bundled, true)).toContain(`(LiteLLM prices of ${LITELLM_DATE})`)
  // a reported $0 that was replaced says so first, and keeps what fits
  const zero = aRun('zz-only/m', { cost: 0, costSource: 'reported' })
  expect(runCost(zero, fetched, true)).toBe('$7.00 est. (reported $0; LiteLLM prices of 2026-10-14)')
  expect(runCost(zero, fetched, true, 34)).toBe('$7.00 est. (reported $0)')
  // an own price (override or Claude table) names no list
  const own = { table: { 'own/m': { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 } }, mode: 'auto' as const, fetched: FETCHED, fetchedAt: 1 }
  expect(runCost(aRun('own/m'), own, true)).toBe('$1.00 est.')
})
