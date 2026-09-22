import type { ToolPolicy } from '@deepseek-ai/dsh-edmore-contracts'
import { CapabilityUnavailableError } from '@deepseek-ai/dsh-edmore-contracts'

export class ToolPolicyRegistry {
  private provider?: ToolPolicy

  register(provider: ToolPolicy): () => void {
    if (this.provider) throw new Error('A tool policy is already registered')
    this.provider = provider
    let disposed = false
    return () => {
      if (disposed) return
      disposed = true
      if (this.provider === provider) this.provider = undefined
    }
  }

  require(): ToolPolicy {
    if (!this.provider) throw new CapabilityUnavailableError('edmore-plan-judge', 'Workflow policy is unavailable; controlled MCP tools cannot execute')
    return this.provider
  }
}
