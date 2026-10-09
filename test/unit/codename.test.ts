import { expect, test } from 'claude-code/testing'

import { codenameFor } from '../../src/codename'

test('codenameFor is deterministic and matches the name pattern', () => {
  const name = codenameFor('a1', new Set())
  expect(codenameFor('a1', new Set())).toBe(name)
  expect(name).toMatch(/^[A-Z]+-[0-9A-Z]{2}$/)
})

test('a taken codename moves to the next suffix with the same duck', () => {
  const first = codenameFor('a1', new Set())
  const second = codenameFor('a1', new Set([first]))
  expect(second).not.toBe(first)
  expect(second.split('-')[0]).toBe(first.split('-')[0])
})

test('2,000 ids in one growing set all get unique codenames', () => {
  const taken = new Set<string>()
  for (let i = 0; i < 2000; i++) taken.add(codenameFor(`run-${i}`, taken))
  expect(taken.size).toBe(2000)
})
