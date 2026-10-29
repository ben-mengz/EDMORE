import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-edmore-plan-judge'
import z from '@deepseek-ai/schemastery'
import { JevDecisions, defaults, type Options } from './provider.ts'

export const name = 'edmore-jev-decisions'
export const inject = ['edmorePlanJudge', 'credentials']
declare module '@deepseek-ai/cordis' {
  interface Context { edmoreJevDecisions: JevDecisions }
}
export const Config = z.object({
  apiKeyRef: z.string().default('TYPESAFE_API_KEY'),
  timeoutMs: z.number().min(100).max(30000).default(2500),
  minConfidence: z.number().min(.5).max(1).default(defaults.minConfidence),
  minMargin: z.number().min(0).max(1).default(defaults.minMargin),
  maxInputBytes: z.number().min(1024).max(128000).default(defaults.maxInputBytes),
  failureLimit: z.number().min(1).max(10).default(defaults.failureLimit),
  cooldownMs: z.number().min(1000).max(300000).default(defaults.cooldownMs),
})

export function apply(ctx: Context, config: Options & { apiKeyRef: string; timeoutMs: number }) {
  const ref = credentialRef(config.apiKeyRef)
  const fetcher: typeof fetch = (input, init) => fetch(
    process.env.EDMORE_AUTH_WORKER === '1' && process.env.EDMORE_JEV_PROXY_URL
      ? process.env.EDMORE_JEV_PROXY_URL : input, init)
  const provider = new JevDecisions(async () => (await ctx.credentials.resolve(ref))?.value, config,
    fetcher, outcome => ctx.logger.debug(`Jev decisions: ${outcome}`))
  ctx.effect(() => ctx.edmorePlanJudge.registerDecisionProvider(provider, config.timeoutMs), 'edmore.jev.decisions')
  ctx.provide('edmoreJevDecisions', provider)
}
