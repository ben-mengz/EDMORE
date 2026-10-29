import type { ToolPolicy } from '@deepseek-ai/dsh-edmore-contracts'
import { CapabilityUnavailableError } from '@deepseek-ai/dsh-edmore-contracts'
import type { Context } from '@deepseek-ai/cordis'

export function installNativeMcpPolicyGuard(ctx: Context, registry: ToolPolicyRegistry): void {
  // Judge is optional. Cancellation and the standard tool permission chain are not.
  ctx.on('tools/execute', async (exec, next) => {
    exec.signal?.throwIfAborted()
    return next()
  })
}

export class ToolPolicyRegistry {
  private provider?: ToolPolicy

  optional(): ToolPolicy | undefined { return this.provider }

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
    if (!this.provider) throw new CapabilityUnavailableError('edmore-plan-judge', 'Workflow Engine is unavailable; controlled MCP tools cannot execute. Workflows remain available as reference material. Enable Workflow Engine to execute them.')
    return this.provider
  }
}
