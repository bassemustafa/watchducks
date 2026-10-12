import { describe, expect, test } from 'claude-code/testing'

import type { Ledger, Run } from '../../types'
import {
  DiscoveryMemory,
  MAX_IDENTITIES,
  MAX_POLL_AGE_MS,
  MAX_SKIPPED,
  POLL_GRACE_MS,
  allowedRoots,
  duePolls,
  fingerprint,
  matchDiscovered,
  pendingDiscovery,
  relayRoots,
  resultPath,
  type FoundResult,
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

describe('fingerprint', () => {
  test('is deterministic, distinguishes inputs and keeps no part of the path', () => {
    expect(fingerprint('/tmp/SENTINEL-DIR/result.json')).toBe(fingerprint('/tmp/SENTINEL-DIR/result.json'))
    expect(fingerprint('/tmp/a/result.json')).not.toBe(fingerprint('/tmp/b/result.json'))
    expect(fingerprint('/tmp/SENTINEL-DIR/result.json')).toMatch(/^[0-9a-z]+-[0-9a-z]+$/)
    expect(fingerprint('/tmp/SENTINEL-DIR/result.json')).not.toContain('SENTINEL')
    expect(fingerprint('/tmp/SENTINEL-DIR/result.json')).not.toContain('/')
  })
})

describe('matchDiscovered', () => {
  const S = NOW - 1000
  const none: ReadonlySet<string> = new Set()
  const pending = (id: string, patch: Partial<Run> = {}): Run => bare(id, { startedAt: S, ...patch })
  // a result that names its tool (the default run is an opencode run)
  const res = (dir: string, startedAt: number, extra: Partial<FoundResult> = {}): FoundResult => ({ dir, startedAt, tool: 'opencode', ...extra })

  test('the start must be within [run - 5 s, run + 60 s]', () => {
    const at = (startedAt: number) => matchDiscovered([pending('r')], [res('/d', startedAt)], none)
    expect(at(S - 5000)).toEqual([{ id: 'r', outDir: '/d' }])
    expect(at(S - 5001)).toEqual([])
    expect(at(S + 60000)).toEqual([{ id: 'r', outDir: '/d' }])
    expect(at(S + 60001)).toEqual([])
  })

  test('a tool that disagrees blocks the pair; an unknown implementer agrees with any named tool', () => {
    const f = (tool: string) => [res('/d', S, { tool })]
    expect(matchDiscovered([pending('r', { implementer: 'claude' })], f('codex'), none)).toEqual([])
    expect(matchDiscovered([pending('r', { implementer: 'claude' })], f('claude'), none)).toHaveLength(1)
    expect(matchDiscovered([pending('r', { implementer: 'unknown' })], f('gemini'), none)).toHaveLength(1)
  })

  test('a result that names no known tool never matches, whatever the run is', () => {
    const noTool: FoundResult = { dir: '/d', startedAt: S }
    expect(matchDiscovered([pending('r', { implementer: 'opencode' })], [noTool], none)).toEqual([])
    expect(matchDiscovered([pending('r', { implementer: 'unknown' })], [noTool], none)).toEqual([])
    expect(matchDiscovered([pending('r', { implementer: 'unknown' })], [res('/d', S, { tool: 'vim' })], none)).toEqual([])
  })

  test('a run with a working directory needs a result that names the same one', () => {
    const f = (workdirKey?: string) => [res('/d', S, workdirKey !== undefined ? { workdirKey } : {})]
    expect(matchDiscovered([pending('r', { workdirKey: 'aa' })], f('bb'), none)).toEqual([])
    expect(matchDiscovered([pending('r', { workdirKey: 'aa' })], f('aa'), none)).toHaveLength(1)
    expect(matchDiscovered([pending('r', { workdirKey: 'aa' })], f(), none)).toEqual([])
  })

  test('a run without a working directory takes a result with any', () => {
    expect(matchDiscovered([pending('r')], [res('/d', S, { workdirKey: 'bb' })], none)).toHaveLength(1)
    expect(matchDiscovered([pending('r')], [res('/d', S)], none)).toHaveLength(1)
  })

  test('a claimed directory is skipped', () => {
    const found = [res('/taken', S), res('/free', S + 5000)]
    expect(matchDiscovered([pending('r')], found, new Set(['/taken']))).toEqual([{ id: 'r', outDir: '/free' }])
    expect(matchDiscovered([pending('r')], [found[0]!], new Set(['/taken']))).toEqual([])
  })

  test('two runs and two directories are paired by closeness, each used once', () => {
    const runs = [pending('a', { startedAt: S }), pending('b', { startedAt: S + 10_000 })]
    const found = [res('/near-b', S + 11_000), res('/near-a', S + 1000)]
    expect(matchDiscovered(runs, found, none)).toEqual([
      { id: 'a', outDir: '/near-a' },
      { id: 'b', outDir: '/near-b' },
    ])
  })

  test('one directory is never given to two runs, and one run takes only one directory', () => {
    const runs = [pending('a', { startedAt: S }), pending('b', { startedAt: S + 2000 })]
    expect(matchDiscovered(runs, [res('/only', S + 1500)], none)).toEqual([{ id: 'b', outDir: '/only' }])
    expect(matchDiscovered([runs[0]!], [res('/x', S), res('/y', S + 1)], none)).toEqual([{ id: 'a', outDir: '/x' }])
  })

  test('the closest pair wins even when it leaves a run unmatched', () => {
    const runs = [pending('a', { startedAt: S }), pending('b', { startedAt: S + 50_000 })]
    expect(matchDiscovered(runs, [res('/d', S + 49_000)], none)).toEqual([{ id: 'b', outDir: '/d' }])
  })

  test('only the 64 newest pending runs take part', () => {
    const runs = Array.from({ length: 65 }, (_, i) => pending('r' + i))
    const found = Array.from({ length: 65 }, (_, i) => res('/d' + i, S))
    const matched = matchDiscovered(runs, found, none)
    expect(matched).toHaveLength(64)
    expect(matched.some(m => m.id === 'r0')).toBe(false)
    expect(matched.some(m => m.id === 'r64')).toBe(true)
  })

  test('only the first 1024 found results take part', () => {
    const found = Array.from({ length: 1025 }, (_, i) => res('/d' + i, S + 1000 + i))
    // 1025 candidates, the closest to the run is first; take them away one by one with claims to reach the cut
    const claimed = new Set(found.slice(0, 1024).map(f => f.dir))
    expect(matchDiscovered([pending('r')], found, claimed)).toEqual([])
    expect(matchDiscovered([pending('r')], found, new Set(found.slice(0, 1023).map(f => f.dir)))).toEqual([{ id: 'r', outDir: '/d1023' }])
  })
})

describe('DiscoveryMemory', () => {
  const FILE = '/tmp/a/result.json'
  const ID = { startedAt: NOW, tool: 'claude' as const }

  test('an identity round-trips, including a file that identified as nothing', () => {
    const m = new DiscoveryMemory()
    expect(m.identity(FILE, 1, 10)).toBeUndefined()
    m.rememberIdentity(FILE, 1, 10, ID)
    expect(m.identity(FILE, 1, 10)).toEqual(ID)
    m.rememberIdentity('/tmp/b/result.json', 1, 10, null)
    expect(m.identity('/tmp/b/result.json', 1, 10)).toBeNull()
  })

  test('a changed mtime or size returns undefined', () => {
    const m = new DiscoveryMemory()
    m.rememberIdentity(FILE, 1, 10, ID)
    expect(m.identity(FILE, 2, 10)).toBeUndefined()
    expect(m.identity(FILE, 1, 11)).toBeUndefined()
  })

  test('a skip is per version: a rewrite is not skipped', () => {
    const m = new DiscoveryMemory()
    m.skip(FILE, 1, 10)
    expect(m.isSkipped(FILE, 1, 10)).toBe(true)
    expect(m.isSkipped(FILE, 2, 10)).toBe(false)
    expect(m.isSkipped(FILE, 1, 11)).toBe(false)
    expect(m.isSkipped('/tmp/other/result.json', 1, 10)).toBe(false)
  })

  test('a cursor round-trips and defaults to 0', () => {
    const m = new DiscoveryMemory()
    expect(m.cursor('/tmp')).toBe(0)
    m.setCursor('/tmp', 7)
    expect(m.cursor('/tmp')).toBe(7)
    expect(m.cursor('/var')).toBe(0)
  })

  test('identities and skips are evicted oldest first at their caps', () => {
    const m = new DiscoveryMemory()
    for (let i = 0; i <= MAX_IDENTITIES; i++) m.rememberIdentity(`/f/${i}`, 1, 1, ID)
    expect(m.identity('/f/0', 1, 1)).toBeUndefined()
    expect(m.identity('/f/1', 1, 1)).toEqual(ID)
    expect(m.identity(`/f/${MAX_IDENTITIES}`, 1, 1)).toEqual(ID)
    const s = new DiscoveryMemory()
    for (let i = 0; i <= MAX_SKIPPED; i++) s.skip(`/f/${i}`, 1, 1)
    expect(s.isSkipped('/f/0', 1, 1)).toBe(false)
    expect(s.isSkipped('/f/1', 1, 1)).toBe(true)
    expect(s.isSkipped(`/f/${MAX_SKIPPED}`, 1, 1)).toBe(true)
    expect(s.keys().length).toBe(MAX_SKIPPED)
  })

  test('clear() empties everything', () => {
    const m = new DiscoveryMemory()
    m.rememberIdentity(FILE, 1, 10, ID)
    m.skip(FILE, 1, 10)
    m.setCursor('/tmp', 3)
    m.clear()
    expect(m.keys()).toEqual([])
    expect(m.identity(FILE, 1, 10)).toBeUndefined()
    expect(m.isSkipped(FILE, 1, 10)).toBe(false)
    expect(m.cursor('/tmp')).toBe(0)
  })

  test('keys are fingerprints, never a path or any text', () => {
    const m = new DiscoveryMemory()
    const file = '/tmp/SENTINEL-x/result.json'
    m.rememberIdentity(file, 1, 10, ID)
    m.skip(file, 1, 10)
    m.setCursor('/tmp/SENTINEL-x', 4)
    expect(m.keys().length).toBe(3)
    for (const key of m.keys()) {
      expect(key).toMatch(/^[0-9a-z]+-[0-9a-z]+$/)
      expect(key).not.toContain('/')
      expect(key).not.toContain('SENTINEL')
    }
  })
})
