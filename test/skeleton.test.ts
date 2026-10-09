import { expect, test } from 'claude-code/testing'

import { fnv1a } from '../src/codename'

test('fnv1a is the 32-bit FNV-1a hash', () => {
  expect(fnv1a('')).toBe(0x811c9dc5)
  expect(fnv1a('a')).toBe(0xe40c292c)
})

test('/flock answers', async $ => {
  const ran = await $.command.run({ command: 'flock', args: '' } as never)
  expect(JSON.stringify(ran)).toContain('on watch')
})
