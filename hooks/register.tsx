import type { Register } from 'claude-code'

import { registerAgentCollectors } from '../src/collect/agents'
import { DUCKS, fnv1a } from '../src/codename'
import { registerLifecycle } from '../src/lifecycle'
import { prices } from '../src/state'

export const register: Register = (on, options) => {
  const table = prices(options)

  registerLifecycle(on, table, options)
  registerAgentCollectors(on, table)

  on('command.run', { command: 'flock' }, async () => {
    return { text: `The flock is on watch (${DUCKS[fnv1a('hq') % 16]}).` }
  })
}
