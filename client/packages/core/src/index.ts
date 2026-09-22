import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { EdmoreEventHub, EdmoreActionRegistry } from './events.ts'
import { features } from '../features.mjs'
import { RuntimeScheduling } from './scheduling.ts'
import { ToolPolicyRegistry } from './policy.ts'
import * as runtime from '@deepseek-ai/dsh-edmore-runtime'
import type { Config as RuntimeConfig } from '@deepseek-ai/dsh-edmore-runtime/services'
import { McpRegistry } from './mcp.ts'
import type { WorkflowControl } from '@deepseek-ai/dsh-edmore-contracts'
import { TaskQueues } from './tasks.ts'

export const name = 'edmore-core'
export const inject = ['agents', 'sessions', 'sessionPersistence', 'systemPrompt', 'tools', 'skills', 'settings', 'credentials', 'llm']
export interface Config { eventLogPath: string; runtime: RuntimeConfig }
export const Config: z<Config> = z.object({ eventLogPath: z.string().required(), runtime: runtime.Config.required() })

declare module '@deepseek-ai/cordis' {
  interface Context {
    edmoreEvents: EdmoreEventHub
    edmoreActions: EdmoreActionRegistry
    edmoreScheduling: RuntimeScheduling
    edmoreToolPolicy: ToolPolicyRegistry
    edmoreNionSwift: McpRegistry
    edmoreWorkflow: WorkflowControl
    edmoreTasks: TaskQueues
    edmoreCapabilities: {
      list(): Array<{ id: string; status: string; missing_dependencies: string[]; error?: string }>
      track(id: string, read: () => { status: string; error?: string }): () => void
    }
  }
}

export async function apply(ctx: Context, config: Config): Promise<void> {
  const events = new EdmoreEventHub(config.eventLogPath)
  await events.ready()
  ctx.provide('edmoreEvents', events)
  ctx.provide('edmoreActions', new EdmoreActionRegistry(events))
  ctx.provide('edmoreScheduling', new RuntimeScheduling())
  ctx.provide('edmoreToolPolicy', new ToolPolicyRegistry())
  ctx.provide('edmoreNionSwift', new McpRegistry())
  ctx.provide('edmoreTasks', new TaskQueues())
  ctx.provide('edmoreToolBridge', {
    schemas: () => ctx.tools.schemas().filter(tool => tool.name.startsWith('mcp__nionswift_')).map(tool => ({ name: tool.name, description: tool.description, parameters: tool.parameters })),
  })
  const tracked = new Map<string, () => { status: string; error?: string }>()
  ctx.provide('edmoreCapabilities', {
    track(id, read) {
      if (tracked.has(id)) throw new Error(`Capability already tracked: ${id}`)
      tracked.set(id, read)
      return () => { if (tracked.get(id) === read) tracked.delete(id) }
    },
    list: () => Object.entries(features).map(([id, feature]) => ({
      id,
      status: ctx.get(feature.service as never) === undefined ? 'unavailable' : 'ready',
      ...tracked.get(id)?.(),
      missing_dependencies: feature.requires.filter(dependency => {
        const service = features[dependency]?.service
        return service !== undefined && ctx.get(service as never) === undefined
      }),
    })),
  })
  ctx.effect(() => () => events.flush(), 'edmore.core.events.flush')
  await runtime.apply(ctx, config.runtime)
}
