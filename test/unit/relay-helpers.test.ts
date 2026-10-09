import { describe, expect, test } from 'claude-code/testing'

import type { Ledger, Run } from '../../types'
import { MAX_POLL_AGE_MS, POLL_GRACE_MS, allowedRoots, duePolls, relayRoots, resultPath } from '../../src/collect/relay'
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

  test('ids come back in creation order', () => {
    expect(duePolls(ledgerOf(run('b', {}), run('a', {})), NOW)).toEqual(['b', 'a'])
  })
})
