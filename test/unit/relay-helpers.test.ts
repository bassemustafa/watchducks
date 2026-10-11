import { describe, expect, test } from 'claude-code/testing'

import type { Ledger, Run } from '../../types'
import {
  MAX_POLL_AGE_MS,
  POLL_GRACE_MS,
  allowedRoots,
  duePolls,
  matchDiscovered,
  pendingDiscovery,
  relayRoots,
  resultPath,
} from '../../src/collect/relay'
import { emptyLedger } from '../../src/ledger'

const NOW = 1_000_000_000_000

function run(id: string, patch: Partial<Run>): Run {
  return {
    id,
    kind: 'relay',
    codename: id,
    implementer: 'opencode',
    readOnly: false,
    status: 'running',
    startedAt: NOW - 1000,
    usage: null,
    usageSource: null,
    cost: null,
    costSource: null,
    costPartial: false,
    editCalls: 0,
    bugsReported: 0,
    reviews: [],
    suspectedHandlers: [],
    outDir: '/tmp/' + id,
    ...patch,
  }
}

function ledgerOf(...runs: Run[]): Ledger {
  const l = emptyLedger('S', 0)
  return { ...l, runs: Object.fromEntries(runs.map(r => [r.id, r])), order: runs.map(r => r.id) }
}

describe('relayRoots', () => {
  test('lists the temp dir, /tmp, the session root, then the option entries', () => {
    expect(relayRoots({ relayRoots: '/srv/a:/srv/b' }, '/var/tmp/x', '/work')).toEqual(['/var/tmp/x', '/tmp', '/work', '/srv/a', '/srv/b'])
  })

  test('drops empty entries and duplicates', () => {
    expect(relayRoots({ relayRoots: ':/srv/a::/tmp:' }, '/tmp', '')).toEqual(['/tmp', '/srv/a'])
  })

  test('an unset or non-string option adds nothing', () => {
    expect(relayRoots({}, '/tmp', '/work')).toEqual(['/tmp', '/work'])
    expect(relayRoots({ relayRoots: 5 }, '/tmp', '/work')).toEqual(['/tmp', '/work'])
  })
})

describe('allowedRoots', () => {
  test('drops the file system root and empty paths', () => {
    expect(allowedRoots(['/tmp', '/', '', '/work'])).toEqual(['/tmp', '/work'])
  })
})

describe('resultPath', () => {
  test('joins the out-dir and result.json with one slash', () => {
    expect(resultPath('/tmp/o1')).toBe('/tmp/o1/result.json')
    expect(resultPath('/tmp/o1/')).toBe('/tmp/o1/result.json')
  })
})

describe('duePolls', () => {
  test('a running relay with an out-dir is due', () => {
    expect(duePolls(ledgerOf(run('r1', {})), NOW)).toEqual(['r1'])
  })

  test('a running relay without an out-dir, or another kind, is not due', () => {
    const { outDir: _gone, ...noDir } = run('r2', {})
    expect(duePolls(ledgerOf(noDir as Run, run('c1', { kind: 'cli' }), run('s1', { kind: 'shell' })), NOW)).toEqual([])
  })

  test('a running relay started 3 h ago or more is dropped', () => {
    expect(duePolls(ledgerOf(run('old', { startedAt: NOW - MAX_POLL_AGE_MS }), run('new', { startedAt: NOW - MAX_POLL_AGE_MS + 1 })), NOW)).toEqual(['new'])
  })

  test('an ended relay stays due for 120 s after it ended', () => {
    const fresh = run('f', { status: 'done', endedAt: NOW - POLL_GRACE_MS + 1 })
    const stale = run('s', { status: 'done', endedAt: NOW - POLL_GRACE_MS })
    expect(duePolls(ledgerOf(fresh, stale), NOW)).toEqual(['f'])
  })

  test('an ended relay with no end time is not due', () => {
    expect(duePolls(ledgerOf(run('e', { status: 'failed' })), NOW)).toEqual([])
  })

  test('a relay whose result was already read is not due, running or ended', () => {
    const ended = run('e', { status: 'done', endedAt: NOW - 1000, resultRead: true })
    expect(duePolls(ledgerOf(run('r', { resultRead: true }), ended, run('n', {})), NOW)).toEqual(['n'])
  })

  test('ids come back in creation order', () => {
    expect(duePolls(ledgerOf(run('b', {}), run('a', {})), NOW)).toEqual(['b', 'a'])
  })
})

function bare(id: string, patch: Partial<Run>): Run {
  const { outDir: _gone, ...rest } = run(id, patch)
  return rest as Run
}

describe('pendingDiscovery', () => {
  test('a running relay with no out-dir and no result is pending; one with an out-dir or another kind is not', () => {
    const l = ledgerOf(bare('r', {}), run('o', {}), bare('c', { kind: 'cli' }), bare('s', { kind: 'shell' }))
    expect(pendingDiscovery(l, NOW).map(r => r.id)).toEqual(['r'])
  })

  test('a relay running for 3 h or more is dropped', () => {
    const l = ledgerOf(bare('old', { startedAt: NOW - MAX_POLL_AGE_MS }), bare('new', { startedAt: NOW - MAX_POLL_AGE_MS + 1 }))
    expect(pendingDiscovery(l, NOW).map(r => r.id)).toEqual(['new'])
  })

  test('an ended relay stays pending for 120 s after it ended; one with no end time or an unknown status does not', () => {
    const l = ledgerOf(
      bare('f', { status: 'ended', endedAt: NOW - POLL_GRACE_MS + 1 }),
      bare('s', { status: 'done', endedAt: NOW - POLL_GRACE_MS }),
      bare('n', { status: 'failed' }),
      bare('u', { status: 'unknown', endedAt: NOW - 1 }),
    )
    expect(pendingDiscovery(l, NOW).map(r => r.id)).toEqual(['f'])
  })

  test('a relay whose result was read is not pending', () => {
    expect(pendingDiscovery(ledgerOf(bare('r', { resultRead: true })), NOW)).toEqual([])
  })
})

describe('matchDiscovered', () => {
  const S = NOW - 1000
  const none: ReadonlySet<string> = new Set()
  const pending = (id: string, patch: Partial<Run> = {}): Run => bare(id, { startedAt: S, ...patch })

  test('the start must be within [run - 5 s, run + 60 s]', () => {
    const at = (startedAt: number) => matchDiscovered([pending('r')], [{ dir: '/d', startedAt }], none)
    expect(at(S - 5000)).toEqual([{ id: 'r', outDir: '/d' }])
    expect(at(S - 5001)).toEqual([])
    expect(at(S + 60000)).toEqual([{ id: 'r', outDir: '/d' }])
    expect(at(S + 60001)).toEqual([])
  })

  test('a tool that disagrees blocks the pair; an unknown implementer or an unnamed tool does not', () => {
    const f = (tool?: string) => [{ dir: '/d', startedAt: S, ...(tool !== undefined ? { tool } : {}) }]
    expect(matchDiscovered([pending('r', { implementer: 'claude' })], f('codex'), none)).toEqual([])
    expect(matchDiscovered([pending('r', { implementer: 'claude' })], f('claude'), none)).toHaveLength(1)
    expect(matchDiscovered([pending('r', { implementer: 'claude' })], f(), none)).toHaveLength(1)
    expect(matchDiscovered([pending('r', { implementer: 'unknown' })], f('gemini'), none)).toHaveLength(1)
  })

  test('a working directory that disagrees blocks the pair; one side unknown does not', () => {
    const f = (workdirKey?: string) => [{ dir: '/d', startedAt: S, ...(workdirKey !== undefined ? { workdirKey } : {}) }]
    expect(matchDiscovered([pending('r', { workdirKey: 'aa' })], f('bb'), none)).toEqual([])
    expect(matchDiscovered([pending('r', { workdirKey: 'aa' })], f('aa'), none)).toHaveLength(1)
    expect(matchDiscovered([pending('r', { workdirKey: 'aa' })], f(), none)).toHaveLength(1)
    expect(matchDiscovered([pending('r')], f('bb'), none)).toHaveLength(1)
  })

  test('a claimed directory is skipped', () => {
    const found = [{ dir: '/taken', startedAt: S }, { dir: '/free', startedAt: S + 5000 }]
    expect(matchDiscovered([pending('r')], found, new Set(['/taken']))).toEqual([{ id: 'r', outDir: '/free' }])
    expect(matchDiscovered([pending('r')], [found[0]!], new Set(['/taken']))).toEqual([])
  })

  test('two runs and two directories are paired by closeness, each used once', () => {
    const runs = [pending('a', { startedAt: S }), pending('b', { startedAt: S + 10_000 })]
    const found = [{ dir: '/near-b', startedAt: S + 11_000 }, { dir: '/near-a', startedAt: S + 1000 }]
    expect(matchDiscovered(runs, found, none)).toEqual([
      { id: 'a', outDir: '/near-a' },
      { id: 'b', outDir: '/near-b' },
    ])
  })

  test('one directory is never given to two runs, and one run takes only one directory', () => {
    const runs = [pending('a', { startedAt: S }), pending('b', { startedAt: S + 2000 })]
    expect(matchDiscovered(runs, [{ dir: '/only', startedAt: S + 1500 }], none)).toEqual([{ id: 'b', outDir: '/only' }])
    expect(matchDiscovered([runs[0]!], [{ dir: '/x', startedAt: S }, { dir: '/y', startedAt: S + 1 }], none)).toEqual([{ id: 'a', outDir: '/x' }])
  })

  test('the closest pair wins even when it leaves a run unmatched', () => {
    const runs = [pending('a', { startedAt: S }), pending('b', { startedAt: S + 50_000 })]
    const found = [{ dir: '/d', startedAt: S + 49_000 }]
    expect(matchDiscovered(runs, found, none)).toEqual([{ id: 'b', outDir: '/d' }])
  })
})
