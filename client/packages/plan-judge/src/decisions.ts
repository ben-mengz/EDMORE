import type { EdmoreEvent } from './index.ts'
import { parseRoute, type RouteInput, type RouteDecision } from './routing.ts'

export interface PlanDecisionInput {
  query: string
  event: EdmoreEvent
  skills: Array<{ skill_id: string; name: string; agents: string[]; required_tools: string[]; ordered_tools: string[] }>
}

export interface StepDecisionInput {
  criterion: string
  result: unknown
}

export interface StepAssessment {
  status: 'success' | 'failure' | 'uncertain'
  reason: string
}

// Extensions may abstain. The workflow retains its original implementation.
export interface DecisionProvider {
  name?: string
  route?(input: RouteInput, signal: AbortSignal, report?: (reason: string) => void): Promise<RouteDecision | undefined>
  shouldPlan(input: PlanDecisionInput, signal: AbortSignal, report?: (reason: string) => void): Promise<boolean | undefined>
  assessStep(input: StepDecisionInput, signal: AbortSignal, report?: (reason: string) => void): Promise<StepAssessment | undefined>
}

export interface DecisionStatus { provider: string; phase: 'started' | 'accepted' | 'fallback'; reason?: string }

export class DecisionExtensions {
  private registration?: { provider: DecisionProvider; timeoutMs: number; controller: AbortController }
  get supportsRouting(): boolean { return typeof this.registration?.provider.route === 'function' }

  register(provider: DecisionProvider, timeoutMs = 2500): () => void {
    if (this.registration) throw new Error('A workflow decision provider is already registered')
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw new Error('Invalid decision timeout')
    const entry = { provider, timeoutMs, controller: new AbortController() }
    this.registration = entry
    return () => {
      if (this.registration !== entry) return
      this.registration = undefined
      entry.controller.abort()
    }
  }

  async run(method: 'route' | 'shouldPlan' | 'assessStep', input: RouteInput | PlanDecisionInput | StepDecisionInput, observe?: (status: DecisionStatus) => Promise<void>): Promise<boolean | StepAssessment | RouteDecision | undefined> {
    const entry = this.registration
    if (!entry) return undefined
    const notify = async (phase: DecisionStatus['phase'], reason?: string) => {
      try { await observe?.({ provider: entry.provider.name ?? 'Decision provider', phase, reason }) } catch { /* UI telemetry must not change decisions. */ }
    }
    await notify('started')
    if (this.registration !== entry) { await notify('fallback', 'provider-disabled'); return undefined }
    const controller = new AbortController()
    const abort = () => controller.abort()
    entry.controller.signal.addEventListener('abort', abort, { once: true })
    let timer: ReturnType<typeof setTimeout> | undefined
    let reason = 'no-decision'
    let accepted = false
    const report = (value: string) => { reason = value }
    try {
      const cancelled = new Promise<undefined>(resolve => {
        controller.signal.addEventListener('abort', () => resolve(undefined), { once: true })
        timer = setTimeout(() => { reason = `timeout-${entry.timeoutMs}ms`; abort() }, entry.timeoutMs)
      })
      const call = method === 'route' ? entry.provider.route?.(structuredClone(input as RouteInput), controller.signal, report) : method === 'shouldPlan'
        ? entry.provider.shouldPlan(structuredClone(input as PlanDecisionInput), controller.signal, report)
        : entry.provider.assessStep(structuredClone(input as StepDecisionInput), controller.signal, report)
      const result = await Promise.race([call, cancelled])
      if (this.registration !== entry) { reason = 'provider-disabled'; return undefined }
      if (controller.signal.aborted) return undefined
      if (method === 'route') { const route = parseRoute(result, input as RouteInput); accepted = route !== undefined; return route }
      if (method === 'shouldPlan') { accepted = typeof result === 'boolean'; return accepted ? result : undefined }
      if (!result || typeof result !== 'object' || !('status' in result) || !['success', 'failure', 'uncertain'].includes(result.status) || typeof result.reason !== 'string' || !result.reason.trim()) return undefined
      accepted = true
      return result
    } catch {
      reason = 'provider-exception'
      return undefined
    } finally {
      clearTimeout(timer)
      entry.controller.signal.removeEventListener('abort', abort)
      controller.abort()
      await notify(accepted ? 'accepted' : 'fallback', reason)
    }
  }
}
