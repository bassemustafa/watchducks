import type { Register } from 'claude-code'

import { DUCKS, fnv1a } from '../src/codename'

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'flock', description: 'Open the watchducks sidebar' })
    return next(e)
  })

  on('command.run', { command: 'flock' }, async () => {
    return { text: `The flock is on watch (${DUCKS[fnv1a('hq') % 16]}).` }
  })
}
