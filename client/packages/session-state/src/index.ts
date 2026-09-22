import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-edmore-core'
import { join } from 'node:path'
import { homedir } from 'node:os'
import z from '@deepseek-ai/schemastery'
import { SessionStateStore } from './core.ts'

export { SessionStateStore } from './core.ts'
export const name = 'edmore-session-state'
export const inject = ['edmoreEvents']
export interface Config { root: string }
export const Config: z<Config> = z.object({ root: z.string().default(join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'edmore/session-state')) })

declare module '@deepseek-ai/cordis' {
  interface Context { edmoreSessionState: SessionStateStore }
}

export async function apply(ctx: Context, config: Config): Promise<void> {
  const hub = ctx.edmoreEvents
  const store = new SessionStateStore(config.root, id => hub.findById(id))
  await store.ready()
  let cursor = 0
  while (true) {
    const page = hub.query({ after: cursor, limit: 1000 })
    if (!page.length) break
    for (const event of page) store.record(event)
    cursor = page[page.length - 1]!.cursor
  }
  await store.flush()
  ctx.effect(() => hub.subscribe(event => store.record(event)), 'edmore.session-state-ingest')
  ctx.provide('edmoreSessionState', store)
  const timer = setInterval(() => { void store.flush().catch(error => ctx.logger.warn(error)) }, 2000)
  timer.unref()
  ctx.effect(() => () => clearInterval(timer), 'edmore.session-state-snapshot')
  ctx.effect(() => () => store.flush(), 'edmore.session-state-flush')
}
