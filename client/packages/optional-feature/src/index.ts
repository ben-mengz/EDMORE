import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-edmore-core'

export const name = 'edmore-optional-feature'
export const inject = ['edmoreCapabilities']
export const Config = z.object({ id: z.string().required(), module: z.string().required(), options: z.any() })

export async function apply(ctx: Context, config: { id: string; module: string; options?: unknown }) {
  let status = 'loading'
  let error: string | undefined
  ctx.effect(() => ctx.edmoreCapabilities.track(config.id, () => ({ status, ...(error ? { error } : {}) })), 'edmore.feature.status')
  try {
    const plugin = await import(config.module)
    const fiber = ctx.plugin(plugin, config.options)
    let stopped = false
    let checking = false
    const refresh = async () => {
      if (stopped || checking) return
      checking = true
      try {
        await fiber.await()
        // Cordis public FiberState.ACTIVE is 2 in the vendored runtime.
        status = fiber.state === 2 ? 'ready' : 'blocked'
      } catch (reason) {
        status = 'failed'
        error = reason instanceof Error ? reason.message : String(reason)
      } finally { checking = false }
    }
    void refresh()
    ctx.effect(() => {
      const timer = setInterval(() => { void refresh() }, 200)
      timer.unref()
      return () => { stopped = true; clearInterval(timer) }
    }, 'edmore.feature.lifecycle')
  } catch (reason) {
    status = 'failed'
    error = reason instanceof Error ? reason.message : String(reason)
    ctx.logger.warn(`Optional feature ${config.id} failed: ${error}`)
  }
}
