import { expect, test } from 'claude-code/testing'

import { PRICES } from '../../src/price'
import { groupFigures, groupIdOf, groupsOf, type Group } from '../../src/ui/groups'
import type { Ledger, Run } from '../../types'

const ZERO = { usage: { uncached: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, cost: null, costPartial: false }
const PRICING = { table: PRICES, mode: 'auto' as const }
const T0 = Date.UTC(2026, 9, 17, 10)
const MIN = 60_000

function run(id: string, over: Partial<Run> = {}): Run {
  return {
    id, kind: 'agent', codename: 'TEAL-00', implementer: 'claude-code', model: 'claude-sonnet-5-5', effort: 'high', readOnly: false,
    status: 'done', startedAt: T0, endedAt: T0 + MIN,
    usage: null, usageSource: null, cost: null, costSource: null, costPartial: false,
    editCalls: 0, bugsReported: 0, reviews: [], suspectedHandlers: [], ...over,
  }
}

function ledgerOf(runs: Run[]): Ledger {
  return {
    v: 1, generation: 0, sessionId: 's1', sessionStartedAt: T0,
    runs: Object.fromEntries(runs.map(r => [r.id, r])), order: runs.map(r => r.id),
    hq: ZERO, overhead: ZERO, turnsWithSteps: {}, countedSteps: {}, findings: {}, bgSeen: {},
    tokenSeries: [], seriesEndMinute: 0, retired: {},
  }
}

const usage = (uncached: number, output = 0, cacheRead = 0, cacheWrite = 0) => ({ uncached, output, cacheRead, cacheWrite })

function only(runs: Run[]): Group {
  const groups = groupsOf(ledgerOf(runs))
  expect(groups.length).toBe(1)
  return groups[0]!
}

test('a run group id is the implementer, model and effort, with a dash for what is missing', () => {
  expect(groupIdOf(run('a'))).toBe('group:claude-code|claude-sonnet-5-5|high')
  expect(groupIdOf(run('a', { effort: 3 }))).toBe('group:claude-code|claude-sonnet-5-5|3')
  expect(groupIdOf(run('a', { model: undefined }))).toBe('group:claude-code|—|high')
  expect(groupIdOf(run('a', { effort: undefined }))).toBe('group:claude-code|claude-sonnet-5-5|—')
  expect(groupIdOf(run('a', { model: undefined, effort: undefined, implementer: 'shell' }))).toBe('group:shell|—|—')
})

test('the same implementer and model with different efforts are two groups', () => {
  const groups = groupsOf(ledgerOf([run('a', { effort: 'high' }), run('b', { effort: 'low' }), run('c', { effort: 'high' })]))
  expect(groups.map(g => g.id).sort()).toEqual(['group:claude-code|claude-sonnet-5-5|high', 'group:claude-code|claude-sonnet-5-5|low'])
  const high = groups.find(g => g.effort === 'high')!
  expect(high.implementer).toBe('claude-code')
  expect(high.model).toBe('claude-sonnet-5-5')
  expect(high.runs.map(r => r.id).sort()).toEqual(['a', 'c'])
  expect(groupsOf(ledgerOf([run('d', { model: undefined, effort: undefined })]))[0]).toMatchObject({ model: '—', effort: '—' })
})

test('a group keeps its runs running first newest first, then ended newest first', () => {
  const g = only([
    run('old', { endedAt: T0 + 1 * MIN }),
    run('new', { endedAt: T0 + 5 * MIN }),
    run('r1', { status: 'running', endedAt: undefined, startedAt: T0 + 2 * MIN }),
    run('r2', { status: 'running', endedAt: undefined, startedAt: T0 + 3 * MIN }),
  ])
  expect(g.runs.map(r => r.id)).toEqual(['r2', 'r1', 'new', 'old'])
})

test('a group with a running run comes first, by its newest running start; ended groups follow by their newest end', () => {
  const groups = groupsOf(
    ledgerOf([
      run('e1', { effort: 'e1', endedAt: T0 + 9 * MIN }),
      run('e2', { effort: 'e2', endedAt: T0 + 20 * MIN }),
      run('e2b', { effort: 'e2', endedAt: T0 + 2 * MIN }),
      run('r1', { effort: 'r1', status: 'running', endedAt: undefined, startedAt: T0 + 3 * MIN }),
      run('r2', { effort: 'r2', status: 'running', endedAt: undefined, startedAt: T0 + 4 * MIN }),
      run('r2done', { effort: 'r2', endedAt: T0 + 30 * MIN }),
    ]),
  )
  expect(groups.map(g => g.effort)).toEqual(['r2', 'r1', 'e2', 'e1'])
})

test('groups with the same newest end are ordered by id', () => {
  const groups = groupsOf(ledgerOf([run('a', { effort: 'b' }), run('b', { effort: 'a' })]))
  expect(groups.map(g => g.effort)).toEqual(['a', 'b'])
})

test('groupFigures counts runs per status and tasks', () => {
  const g = only([
    run('a', { status: 'running', endedAt: undefined }),
    run('b', { status: 'running', endedAt: undefined }),
    run('c'),
    run('d', { status: 'failed' }),
    run('e', { status: 'killed' }),
    run('f', { status: 'ended' }),
    run('g', { status: 'unknown' }),
  ])
  const f = groupFigures(g, T0 + 10 * MIN, PRICING)
  expect(f.counts).toEqual({ running: 2, done: 1, failed: 1, killed: 1, ended: 1, unknown: 1 })
  expect(f.tasks).toBe(7)
})

test('the time of a group runs to now while any run is running, else to the latest end', () => {
  const running = only([run('a', { startedAt: T0 + 1 * MIN, endedAt: T0 + 2 * MIN }), run('b', { status: 'running', endedAt: undefined, startedAt: T0 + 4 * MIN })])
  expect(groupFigures(running, T0 + 10 * MIN, PRICING).elapsedMs).toBe(9 * MIN)
  const ended = only([run('a', { startedAt: T0 + 1 * MIN, endedAt: T0 + 6 * MIN }), run('b', { startedAt: T0 + 2 * MIN, endedAt: T0 + 4 * MIN })])
  expect(groupFigures(ended, T0 + 99 * MIN, PRICING).elapsedMs).toBe(5 * MIN)
})

test('tokens sum the runs that have usage, null when none has, and approx when any summed run is', () => {
  const none = groupFigures(only([run('a'), run('b')]), T0, PRICING)
  expect(none.tokens).toBeNull()
  expect(none.usage).toBeNull()
  expect(none.approx).toBe(false)

  const some = groupFigures(only([run('a', { usage: usage(100, 10, 50, 5) }), run('b'), run('c', { usage: usage(1, 2, 3, 4) })]), T0, PRICING)
  expect(some.tokens).toBe(175)
  expect(some.usage).toEqual({ uncached: 101, output: 12, cacheRead: 53, cacheWrite: 9 })
  expect(some.approx).toBe(false)

  // an approximate run without usage adds nothing; one with usage marks the sum
  expect(groupFigures(only([run('a', { usage: usage(1) }), run('b', { approx: true })]), T0, PRICING).approx).toBe(false)
  expect(groupFigures(only([run('a', { usage: usage(1) }), run('b', { usage: usage(1), approx: true })]), T0, PRICING).approx).toBe(true)
})

test('cost sums the shown costs, reported only when every costed run is reported', () => {
  const none = groupFigures(only([run('a', { kind: 'cli' }), run('b', { kind: 'shell' })]), T0, PRICING)
  expect(none.cost).toBeNull()
  expect(none.costSource).toBeNull()
  expect(none.costPartial).toBe(false)

  const reported = groupFigures(only([run('a', { cost: 0.5, costSource: 'reported' }), run('b', { cost: 0.25, costSource: 'reported' }), run('c', { kind: 'cli' })]), T0, PRICING)
  expect(reported.cost).toBe(0.75)
  expect(reported.costSource).toBe('reported')
  expect(reported.costPartial).toBe(false)

  const mixed = groupFigures(only([run('a', { cost: 0.5, costSource: 'reported' }), run('b', { cost: 0.25, costSource: 'estimated' })]), T0, PRICING)
  expect(mixed.cost).toBe(0.75)
  expect(mixed.costSource).toBe('estimated')
})

test('cost is partial when a run is, or an agent or a relay that could report one has none', () => {
  expect(groupFigures(only([run('a', { cost: 0.5, costSource: 'estimated', costPartial: true })]), T0, PRICING).costPartial).toBe(true)
  // an agent with no cost yet
  const agent = groupFigures(only([run('a', { cost: 0.5, costSource: 'estimated' }), run('b')]), T0, PRICING)
  expect(agent.cost).toBe(0.5)
  expect(agent.costPartial).toBe(true)
  // a relay with an out dir could report one; a codex relay, or one without an out dir, never will
  const relay = { kind: 'relay' as const, implementer: 'opencode' as const, model: 'm', effort: 'high' }
  expect(groupFigures(only([run('a', { ...relay, outDir: '/o' })]), T0, PRICING).costPartial).toBe(true)
  expect(groupFigures(only([run('a', { ...relay })]), T0, PRICING).costPartial).toBe(false)
  expect(groupFigures(only([run('a', { ...relay, implementer: 'codex', outDir: '/o' })]), T0, PRICING).costPartial).toBe(false)
})

test('vetted counts runs with a review, and bugs add the reported ones and the reviews', () => {
  const review = (bugs: number | null) => ({ reviewerId: 'x', bugs, edits: 0, source: 'verdict' as const, at: T0 })
  const f = groupFigures(
    only([
      run('a', { reviews: [review(2), review(null)], bugsReported: 1 }),
      run('b', { reviews: [review(1)] }),
      run('c', { bugsReported: 3 }),
      run('d'),
    ]),
    T0,
    PRICING,
  )
  expect(f.vetted).toBe(2)
  // 1 + 2 + 0 on a, 1 on b, 3 reported on c
  expect(f.bugs).toBe(7)
})
