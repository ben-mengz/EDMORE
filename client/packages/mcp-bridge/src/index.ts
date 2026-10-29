import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { NionSwiftBridge, EdmoreHarnessMcpToolBridge } from './bridge.ts'

export const name = 'edmore-mcp-bridge'
export const inject = ['edmoreEvents', 'edmoreNionSwift', 'edmoreToolPolicy', 'tools']
export const Config = z.object({ baseUrl: z.string().required(), headers: z.dict(String).default({}), pollMs: z.number().min(500).default(3000) })
declare module '@deepseek-ai/cordis' { interface Context { edmoreMcpBridge: boolean } }

export async function apply(ctx: Context, config: { baseUrl: string; headers?: Record<string, string>; pollMs: number }) {
  const connection = new NionSwiftBridge(ctx.edmoreEvents, config.baseUrl.replace(/\/$/, ''), config.headers)
  ctx.effect(() => ctx.edmoreNionSwift.register(connection), 'edmore.mcp.connection')
  const bridge = new EdmoreHarnessMcpToolBridge(ctx, ctx.edmoreEvents, ctx.edmoreNionSwift, ctx.edmoreToolPolicy)
  let pending = Promise.resolve()
  let stopped = false
  const poll = () => {
    pending = pending.then(async () => {
      if (stopped) return
      await connection.observe()
      await bridge.sync()
    }).catch(error => ctx.logger.warn(error instanceof Error ? error : new Error(String(error))))
    return pending
  }
  ctx.effect(() => {
    const timer = setInterval(() => { void poll() }, config.pollMs)
    return async () => { stopped = true; clearInterval(timer); await pending; await bridge.dispose() }
  }, 'edmore.mcp.lifecycle')
  await poll()
  ctx.provide('edmoreMcpBridge', true)
}
