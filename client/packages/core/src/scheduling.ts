import type { RuntimeScheduler, RuntimeDispatch } from '@deepseek-ai/dsh-edmore-contracts'
import { CapabilityUnavailableError } from '@deepseek-ai/dsh-edmore-contracts'

export class RuntimeScheduling {
  private provider?: RuntimeScheduler

  register(provider: RuntimeScheduler): () => void {
    if (this.provider) throw new Error('A runtime scheduler is already registered')
    this.provider = provider
    let disposed = false
    return () => {
      if (disposed) return
      disposed = true
      if (this.provider === provider) this.provider = undefined
    }
  }

  bindSession(harnessSessionId: string, sessionId: string): void {
    this.provider?.bindSession(harnessSessionId, sessionId)
  }

  next(sessionId: string, workflowId: string) {
    if (!this.provider) throw new CapabilityUnavailableError('edmore-plan-judge', 'Workflow scheduling capability is unavailable; execution cannot continue')
    return this.provider.next(sessionId, workflowId)
  }

  async pauseEmptyOutput(sessionId: string, dispatch: RuntimeDispatch, correlationId: string, reason: string): Promise<boolean> {
    if (!this.provider?.pauseEmptyOutput) throw new CapabilityUnavailableError('edmore-plan-judge', 'Workflow pause capability is unavailable')
    return this.provider.pauseEmptyOutput(sessionId, dispatch, correlationId, reason)
  }
}
