import type { On } from 'claude-code'
import type { MockClock } from 'claude-code/testing'
import { expect, mock, test, type Engine } from 'claude-code/testing'

const START = { cwd: '/work', surface: null, isInteractive: true }
const URL = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json'
const KEY = 'prices/litellm/v1'
const HOUR = 3_600_000
const DAY = 24 * HOUR
// 2026-10-14 12:00 UTC
const T = Date.UTC(2026, 9, 14, 12)

type Answer = { status: number; ok: boolean; headers: Record<string, string>; text: string }
const ok = (text: string): Answer => ({ status: 200, ok: true, headers: {}, text })

/** A price list of 120 chat models (m-0 ... m-119) plus one only the refresh knows: $1000 in, $2000 out per million. */
function listText(extra: Record<string, unknown> = {}): string {
  const list: Record<string, unknown> = {}
  for (let i = 0; i < 120; i++) list[`m-${i}`] = { mode: 'chat', input_cost_per_token: 1e-6, output_cost_per_token: 2e-6 }
  list['zz-fetched-only'] = { mode: 'chat', input_cost_per_token: 1e-3, output_cost_per_token: 2e-3 }
  return JSON.stringify({ ...list, ...extra })
}

type Record4 = { v: number; fetchedAt: number; attemptedAt: number; rates: Record<string, [number, number, number, number]> }
const recordAt = (fetchedAt: number, attemptedAt = fetchedAt, rates: Record4['rates'] = { 'zz-fetched-only': [1000, 2000, 0, 0] }): Record4 => ({
  v: 1,
  fetchedAt,
  attemptedAt,
  rates,
})

type World = {
  entries: Map<string, unknown>
  sets: string[]
  fetches: Array<{ url: string; init: unknown }>
  clock: MockClock
}

// The world beneath the plugin: a store in memory that remembers what was written, the clock at T, the environment, and the
// network answering `answer`. Every hook is registered before the first call to `$`.
function world(
  on: On,
  o: { entries?: Record<string, unknown>; env?: Record<string, string>; answer?: () => Promise<Answer>; id?: string } = {},
): World {
  const entries = new Map<string, unknown>(Object.entries(o.entries ?? {}))
  const sets: string[] = []
  const fetches: World['fetches'] = []
  on('command.register', async () => ({ value: { command: 'flock' } }))
  on('tool.register', async () => ({ value: { tool: 'mcp__watchducks__x' } }))
  on('session.id', async () => ({ value: o.id ?? 'S1' }))
  on('session.root', async () => ({ value: '/work' }))
  on('session.surfaces', async () => ({ value: ['terminal'] as never }))
  on('session.start', async ($, e) => ({ cwd: e.cwd }))
  on('session.end', async () => ({ sessionId: 'S1' }))
  on('store.keys', async () => ({ value: [...entries.keys()] }))
  on('store.get', async ($, e) => ({ value: entries.get(e.key) }))
  on('store.set', async ($, e) => {
    sets.push(JSON.stringify(e.value))
    entries.set(e.key, JSON.parse(JSON.stringify(e.value)))
    return { value: undefined }
  })
  on('store.delete', async ($, e) => {
    entries.delete(e.key)
    return { value: undefined }
  })
  on('http.fetch', async ($, e) => {
    fetches.push({ url: e.url, init: e.init })
    return { value: await (o.answer ?? (async () => ok(listText())))() }
  })
  mock.env(on, o.env ?? {})
  return { entries, sets, fetches, clock: mock.clock(on, { now: T }) }
}

const stored = (w: World): Record4 => w.entries.get(KEY) as Record4

test('priceUpdates on, empty store: one GET to the fixed URL with no init, and the projected list is stored', async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  await w.clock.settle()
  expect(w.fetches.length).toBe(1)
  expect(w.fetches[0]!.url).toBe(URL)
  expect(w.fetches[0]!.init).toBeUndefined()
  const record = stored(w)
  expect(Object.keys(record).sort()).toEqual(['attemptedAt', 'fetchedAt', 'rates', 'v'])
  expect(record.v).toBe(1)
  expect(record.fetchedAt).toBe(T)
  expect(record.attemptedAt).toBe(T)
  expect(Object.keys(record.rates).length).toBe(121)
  expect(record.rates['zz-fetched-only']).toEqual([1000, 2000, 0, 0])
  expect(record.rates['m-7']).toEqual([1, 2, 0, 0])
})

test('the attempt is stored before the request is made', async ($, on) => {
  let setsWhenAsked = -1
  let w: World | undefined
  w = world(on, {
    answer: async () => {
      setsWhenAsked = w!.sets.length
      return ok(listText())
    },
  })
  await $.session.start(START)
  await w.clock.settle()
  // the first write of the record is the attempt (no list yet), made before the request; the second is the list
  expect(setsWhenAsked).toBe(1)
  const first = JSON.parse(w.sets[0]!) as Record4
  expect(first.fetchedAt).toBe(0)
  expect(first.attemptedAt).toBe(T)
  expect(Object.keys(first.rates).length).toBe(0)
  expect(w.sets.length).toBe(2)
})

test('a second session the same day does not fetch', async ($, on) => {
  const w = world(on, { entries: { [KEY]: recordAt(T - 3 * HOUR) } })
  await $.session.start(START)
  await w.clock.settle()
  expect(w.fetches.length).toBe(0)
})

test('a list older than a day is fetched again', async ($, on) => {
  const w = world(on, { entries: { [KEY]: recordAt(T - DAY - HOUR) } })
  await $.session.start(START)
  await w.clock.settle()
  expect(w.fetches.length).toBe(1)
  expect(stored(w).fetchedAt).toBe(T)
})

test('an attempt under an hour ago that failed is not repeated', async ($, on) => {
  const w = world(on, { entries: { [KEY]: recordAt(0, T - 30 * 60_000, {}) } })
  await $.session.start(START)
  await w.clock.settle()
  expect(w.fetches.length).toBe(0)
})

test('an attempt over an hour ago that failed is repeated', async ($, on) => {
  const w = world(on, { entries: { [KEY]: recordAt(0, T - 61 * 60_000, {}) } })
  await $.session.start(START)
  await w.clock.settle()
  expect(w.fetches.length).toBe(1)
})

test('a record that does not check out is ignored as if absent', async ($, on) => {
  const w = world(on, { entries: { [KEY]: { v: 1, fetchedAt: T, attemptedAt: T, rates: { 'bad key': [1, 2, 3, 4] } } } })
  await $.session.start(START)
  await w.clock.settle()
  expect(w.fetches.length).toBe(1)
})

test('priceUpdates off: no request, nothing stored', { timeoutMs: 20_000, options: { priceUpdates: 'off' } }, async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  await w.clock.settle()
  await w.clock.advance(61 * 60_000) // past one hourly re-check
  expect(w.fetches.length).toBe(0)
  expect(w.entries.has(KEY)).toBe(false)
})

test('CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC set: no request, nothing stored', async ($, on) => {
  const w = world(on, { env: { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' } })
  await $.session.start(START)
  await w.clock.settle()
  expect(w.fetches.length).toBe(0)
  expect(w.entries.has(KEY)).toBe(false)
})

test('a hung request does not delay session.start, and ends at 20 s without a list', async ($, on) => {
  const w = world(on, { answer: () => new Promise<Answer>(() => {}) })
  await $.session.start(START) // returns while nothing was asked yet
  expect(w.fetches.length).toBe(0)
  await w.clock.settle()
  expect(w.fetches.length).toBe(1)
  await w.clock.advance(20_000)
  expect(stored(w).fetchedAt).toBe(0)
  expect(stored(w).attemptedAt).toBe(T)
})

test('an answer after the 20 s limit is ignored', async ($, on) => {
  let release: (a: Answer) => void = () => {}
  const w = world(on, { answer: () => new Promise<Answer>(resolve => (release = resolve)) })
  await $.session.start(START)
  await w.clock.settle()
  await w.clock.advance(20_000)
  release(ok(listText()))
  await w.clock.settle()
  expect(stored(w).fetchedAt).toBe(0)
})

const bad: Array<[string, Answer]> = [
  ['a refused request', { status: 403, ok: false, headers: {}, text: listText() }],
  ['text that is not JSON', ok('<html>not a price list</html>')],
  ['a list of fewer than 100 models', ok(JSON.stringify({ 'm-1': { mode: 'chat', input_cost_per_token: 1e-6 } }))],
  ['a list over 8 MiB', ok(listText({ pad: 'x'.repeat(8 * 1024 * 1024 + 1) }))],
]
for (const [name, answer] of bad) {
  test(`${name} leaves the stored list as it was`, async ($, on) => {
    const w = world(on, { entries: { [KEY]: recordAt(T - 2 * DAY, T - 2 * DAY, { 'old-model': [1, 1, 1, 1] }) }, answer: async () => answer })
    await $.session.start(START)
    await w.clock.settle()
    expect(w.fetches.length).toBe(1)
    expect(Object.keys(stored(w).rates)).toEqual(['old-model'])
    expect(stored(w).fetchedAt).toBe(T - 2 * DAY)
    expect(stored(w).attemptedAt).toBe(T)
  })
}

test('a request that throws leaves the stored list as it was', async ($, on) => {
  const w = world(on, {
    entries: { [KEY]: recordAt(T - 2 * DAY, T - 2 * DAY, { 'old-model': [1, 1, 1, 1] }) },
    answer: async () => {
      throw new Error('offline')
    },
  })
  await $.session.start(START)
  await w.clock.settle()
  expect(Object.keys(stored(w).rates)).toEqual(['old-model'])
  expect(stored(w).attemptedAt).toBe(T)
})

test('a session left open looks again about once an hour and refreshes when the list has aged a day', { timeoutMs: 20_000 }, async ($, on) => {
  const w = world(on, { entries: { [KEY]: recordAt(T - DAY + 30 * 60_000) } })
  await $.session.start(START)
  await w.clock.settle()
  expect(w.fetches.length).toBe(0)
  await w.clock.advance(61 * 60_000)
  expect(w.fetches.length).toBe(1)
  expect(stored(w).fetchedAt).toBeGreaterThan(T + 30 * 60_000)
})

// ---- the fetched rates reach the sinks

const USAGE = { model: 'zz-fetched-only', input_tokens: 1000, output_tokens: 1000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

function pane($: Engine) {
  return $.ui.mount({
    plugin: 'watchducks',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'flock',
    props: { title: 'The Flock', isFocused: false, bodyColumns: 52, placement: 'dock' } as never,
    viewport: { columns: 56, rows: 40, isFullscreen: true },
  })
}

async function agentOfModel($: Engine, on: On, entries?: Record<string, unknown>): Promise<void> {
  mock.store(on, entries)
  on('agent.spawn', async () => ({ model: 'zz-fetched-only', agentId: 'a1' }))
  on('turn.step', async function* () {
    return { turnId: 't1', index: 0, answer: '', toolUses: [], stopReason: 'end_turn', usage: USAGE } as never
  })
  await $.agent.spawn({ subagentType: 'Explore' } as never)
  for await (const _ of $.turn.step({ agentId: 'a1', turnId: 't1', index: 0, model: 'zz-fetched-only' } as never)) {
    /* chunks are never read */
  }
}

test('a model only the fetched list knows is priced: the card shows est. and the dossier names the list date', async ($, on) => {
  await agentOfModel($, on, { [KEY]: recordAt(T) })
  const ui = await pane($)
  const card = JSON.stringify(await ui.drawn())
  // 1000 in at $1000/M + 1000 out at $2000/M
  expect(card).toContain('$3.00 est.')
  await ui.press({ key: 'a1' })
  expect(JSON.stringify(await ui.drawn())).toContain('$3.00 est. (LiteLLM 2026-10-14)')
  await ui.unmount()
})

test('with no stored list the same model is unpriced', async ($, on) => {
  await agentOfModel($, on)
  const ui = await pane($)
  const card = JSON.stringify(await ui.drawn())
  expect(card).not.toContain('est.')
  expect(card).not.toContain('$3.00')
  await ui.unmount()
})

test('an invalid stored list is ignored by the sinks', async ($, on) => {
  await agentOfModel($, on, { [KEY]: { v: 1, fetchedAt: T, attemptedAt: T, rates: { 'zz-fetched-only': [-1, 2, 0, 0] } } })
  const ui = await pane($)
  expect(JSON.stringify(await ui.drawn())).not.toContain('est.')
  await ui.unmount()
})

test('costMode reported keeps the fetched list out of the cards', { options: { costMode: 'reported' } }, async ($, on) => {
  await agentOfModel($, on, { [KEY]: recordAt(T) })
  const ui = await pane($)
  expect(JSON.stringify(await ui.drawn())).not.toContain('est.')
  await ui.unmount()
})

// ---- privacy: the answer is projected to numbers by name

test('privacy canary: strings in a price list answer reach no store record, state, toast, status or tree', { options: { notify: 'on' } }, async ($, on) => {
  const state: string[] = []
  const shown: string[] = []
  on('state.set', { plugin: 'watchducks', key: 'ledger' }, async ($, e, next) => {
    state.push(JSON.stringify(e.value))
    return next(e)
  })
  on('state.set', { plugin: 'watchducks', key: 'ui' }, async ($, e, next) => {
    state.push(JSON.stringify(e.value))
    return next(e)
  })
  on('ui.toast', async ($, e) => {
    shown.push(e.text)
    return { value: undefined }
  })
  on('ui.status', async ($, e) => {
    shown.push(e.text ?? '')
    return { value: undefined }
  })
  on('ui.panes', async () => ({ value: [{ id: 'flock', title: 'The Flock', isShown: true, isFocused: false, isPlaced: false }] }))
  on('ui.render', { component: 'AbovePrompt' }, async ($, e) => {
    const { Text } = $.ui.resolve(e) as unknown as { Text: (props: { children: string }) => never }
    return Text({ children: '' })
  })
  on('agent.spawn', async () => ({ model: 'zz-fetched-only', agentId: 'a1' }))
  on('turn.step', async function* () {
    return { turnId: 't1', index: 0, answer: '', toolUses: [], stopReason: 'end_turn', usage: USAGE } as never
  })
  on('turn.complete', async () => ({ text: '' }))
  on('classic.Stop', async () => ({}))
  const extra = {
    'SENTINEL bad key': { mode: 'chat', input_cost_per_token: 1e-6 },
    'SENTINEL-TOP': 'SENTINEL-STRING',
    sample_spec: { mode: 'chat', input_cost_per_token: 0, litellm_provider: 'SENTINEL-SAMPLE' },
    'm-0': { mode: 'chat', input_cost_per_token: 1e-6, output_cost_per_token: 2e-6, litellm_provider: 'SENTINEL-PROVIDER', source: 'SENTINEL-URL', supported_modalities: ['SENTINEL-MODALITY'] },
  }
  const w = world(on, { answer: async () => ok(listText(extra)) })
  await $.session.start(START)
  await $.agent.spawn({ subagentType: 'Explore', prompt: 'p' } as never)
  for await (const _ of $.turn.step({ agentId: 'a1', turnId: 't1', index: 0, model: 'zz-fetched-only' } as never)) {
    /* chunks are never read */
  }
  await $.turn.complete({ agentId: 'a1', turnId: 't1', reason: 'answer', answer: '', durationMs: 1, isAborted: false } as never)
  await w.clock.advance(3000)
  await $.session.end({ reason: 'exit' } as never)

  expect(stored(w).fetchedAt).toBeGreaterThan(0)
  const trees: string[] = []
  const ui = await pane($)
  trees.push(JSON.stringify(await ui.drawn()))
  await ui.press({ key: 'a1' })
  trees.push(JSON.stringify(await ui.drawn()))
  await ui.unmount()
  expect(trees[0]).toContain('est.')
  const dump = JSON.stringify([w.sets, state, shown, trees])
  expect(dump).not.toContain('SENTINEL')
  expect(dump).not.toContain('sentinel')
  expect(Object.keys(stored(w).rates)).not.toContain('sample_spec')
})
