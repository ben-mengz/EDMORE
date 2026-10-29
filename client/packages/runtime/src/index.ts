import type { Context } from '@deepseek-ai/cordis'
import { workflowMcpView } from './workflow-mcp.ts'
import { Config, EdmoreLlmProviderManager, EdmoreAgentRoleManager, EdmoreSkillContext, EdmoreAgentLoopBridge, asRecord, isLegacyNionSwiftTrigger, textOf, isLegacyWorkflowConfirmation, confirmationContextFromLegacyNionSwiftTrigger, withOptionalSession, promptFromLegacyNionSwiftTrigger, displayTextFromLegacyNionSwiftTrigger } from './services.ts'
export { Config } from './services.ts'
export const name = 'edmore-runtime'
export const inject = ['agents', 'sessions', 'systemPrompt', 'tools', 'skills', 'edmoreEvents', 'edmoreActions', 'edmoreScheduling', 'edmoreToolPolicy']
export async function apply(ctx: Context, config: Config): Promise<void> {
  const hub = ctx.edmoreEvents
  const actions = ctx.edmoreActions
  const nionSwift = workflowMcpView(ctx.edmoreNionSwift, () => ctx.tools.schemas())
  const llmProviders = new EdmoreLlmProviderManager(ctx, hub, config.llmProviderStorePath, {
    provider: config.assistantProvider,
    model: config.assistantModel,
    ...config.assistantReasoningEffort === undefined ? {} : { reasoningEffort: config.assistantReasoningEffort },
    maxTokens: config.assistantMaxTokens,
    timeoutMs: config.assistantTimeoutMs,
  })
  await llmProviders.ready()
  ctx.effect(() => llmProviders.startSyncLoop(), 'edmore.llm-provider-sync')
  const agentRoles = new EdmoreAgentRoleManager(hub, config.agentRoleStorePath, llmProviders, nionSwift)
  await agentRoles.ready()
  const skillContext = new EdmoreSkillContext(ctx, process.cwd())
  const agentLoop = new EdmoreAgentLoopBridge(ctx, hub, agentRoles, ctx.edmoreScheduling)
  ctx.provide('edmoreLlmProviders', llmProviders)
  ctx.provide('edmoreAgentRoles', agentRoles)
  ctx.provide('edmoreSkills', skillContext)
  ctx.provide('edmoreAgentLoop', agentLoop)

  await hub.append({ type: 'edmore.server.started', source: 'edmore-harness', scope: 'global', payload: { runtime: 'deepseek-harness-cordis' } })
  ctx.effect(() => async () => {
    await ctx.edmoreTasks.dispose()
    await agentLoop.dispose()
    await hub.append({ type: 'edmore.server.stopped', source: 'edmore-harness', scope: 'global', payload: {} })
    await hub.flush()
  }, 'edmore.lifecycle')

  const routedLegacyTriggers = new Set<string>()
  ctx.effect(() => hub.subscribe((event) => {
    if (isLegacyNionSwiftTrigger(event)) {
      const payload = asRecord(event.payload)
      const legacyKey = `${event.server_id ?? event.source}:${textOf(payload.agent)}:${textOf(payload.event_type)}:${textOf(payload.local_cursor) || event.event_id}`
      if (!routedLegacyTriggers.has(legacyKey)) {
        routedLegacyTriggers.add(legacyKey)
        const routedSessionId = ctx.get('edmoreWorkflow')?.routeSessionForLegacyTrigger(event)
        const asConfirmation = routedSessionId !== undefined && isLegacyWorkflowConfirmation(event)
        const confirmationContext = asConfirmation ? confirmationContextFromLegacyNionSwiftTrigger(event) : undefined
        void hub.append(withOptionalSession({
          type: 'edmore.trigger.requested',
          source: 'edmore-trigger-router',
          scope: 'workflow',
          ...event.server_id === undefined ? {} : { server_id: event.server_id },
          correlation_id: event.event_id,
          payload: {
            prompt: promptFromLegacyNionSwiftTrigger(event, asConfirmation),
            display_text: displayTextFromLegacyNionSwiftTrigger(event, asConfirmation),
            origin: 'nionswift-mcp',
            legacy_event_id: event.event_id,
            legacy_cursor: event.cursor,
            legacy_event_type: payload.event_type,
            source_event: {
              event_id: event.event_id, timestamp: event.timestamp, source: event.source,
              type: event.type, session_id: event.session_id, payload: event.payload,
            },
            agent: payload.agent,
            ...confirmationContext === undefined ? {} : { confirmation_context: confirmationContext },
          },
        }, routedSessionId)).catch(error => ctx.logger.warn(error instanceof Error ? error : new Error(String(error))))
      }
      return
    }
    if (event.type !== 'edmore.trigger.requested') return
    void (async () => {
      const workflow = ctx.get('edmoreWorkflow')
      const payload = asRecord(event.payload)
      if (!workflow && (payload.plan_mode === true || /^[\\/]plan(?:\s+|$)|^enable workflow mode[.!]?$/i.test(textOf(payload.prompt).trim()))) {
        await hub.append(withOptionalSession({ type: 'edmore.assistant.completed', source: name, scope: 'workflow', correlation_id: event.event_id,
          payload: { text: 'Workflow mode is unavailable because the Judge plugin is unavailable. No action was executed.' } }, event.session_id))
        return
      }
      const route = workflow ? await workflow.handleTrigger(event) : { action: 'chat' as const }
      if (route.action === 'chat') {
        await agentLoop.handleTrigger(route.executionPrompt ? { ...event, payload: { ...event.payload as object, prompt: route.executionPrompt } } : event)
        return
      }
      if (route.action === 'execute' && route.executionPrompt !== undefined) {
        await agentLoop.runWorkflow(event, route.executionPrompt, route.workflowId, route.role)
      }
    })().catch(error => ctx.logger.warn(error instanceof Error ? error : new Error(String(error))))
  }), 'edmore.trigger-dispatch')


}
