import type { Register } from 'claude-code'

import { registerAgentCollectors } from '../src/collect/agents'
import { registerReviewCollectors } from '../src/collect/review'
import { registerShellCollector } from '../src/collect/shell'
import { registerCommands } from '../src/commands'
import { registerLifecycle } from '../src/lifecycle'
import { prices } from '../src/state'
import { registerTools } from '../src/tools'
import { registerBand } from '../src/ui/band'
import { registerSidebar } from '../src/ui/sidebar'

export const register: Register = (on, options) => {
  const table = prices(options)

  registerLifecycle(on, table, options)
  registerAgentCollectors(on, table)
  registerShellCollector(on, table)
  registerReviewCollectors(on, table)
  registerTools(on, table)

  registerCommands(on, table, options)
  registerSidebar(on, options)
  registerBand(on, options)
}
