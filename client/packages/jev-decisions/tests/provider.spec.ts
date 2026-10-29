import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import * as plugin from '../src/index.ts'
import { JevDecisions, defaults, sanitize } from '../src/provider.ts'
import { DecisionExtensions } from '../../plan-judge/src/decisions.ts'
import type { PlanDecisionInput, StepDecisionInput } from '../../plan-judge/src/decisions.ts'

const input: PlanDecisionInput = { query: 'Acquire a 4D-STEM dataset', event: { event_id:'x', cursor:0, timestamp:'', source:'test', type:'query', scope:'session', payload:{} }, skills:[] }
const step: StepDecisionInput = {
  criterion:'A saved image file is required; starting acquisition is insufficient.', result:{started:true},
}
function answer(choice = 'plan', probabilities: Record<string, number> = {plan:.98, direct:.02}) {
  return {model:'jev-1.13.0', answers:{decision:{type:'choice',choice,confidence:probabilities[choice], probabilities}}}
}
function setup(body: unknown = answer(), options = defaults) {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(body))
  const key = vi.fn(async () => 'test-credential')
  const report = vi.fn()
  return { provider:new JevDecisions(key, options, fetcher, report), fetcher, key, report }
}
const signal = () => new AbortController().signal
afterEach(() => vi.useRealTimers())

describe('Jev transport and decision policy', () => {
  it('uses the tested Gateway, typed enum and supplied key', async () => {
    const s = setup()
    expect(await s.provider.shouldPlan(input,signal())).toBe(true)
    const [url, init] = s.fetcher.mock.calls[0]!
    expect(url).toBe('https://api.typesafe.ai/v1/systemone')
    expect(init).toMatchObject({redirect:'error',headers:{Authorization:'Bearer test-credential'}})
    const body = JSON.parse(init!.body as string)
    expect(body).toMatchObject({model:'jev-latest',state:{query:input.query}})
    expect(Object.keys(body.questions.decision).sort()).toEqual(['criteria','instructions','type'])
  })
  it('accepts a high-confidence direct answer', async () => {
    expect(await setup(answer('direct',{plan:.01,direct:.99})).provider.shouldPlan(input,signal())).toBe(false)
  })
  it('accepts independently reported confidence and choice probability from the official API', async () => {
    const body = answer('direct', { direct: .97, plan: .03 })
    body.answers.decision.confidence = .94
    expect(await setup(body).provider.shouldPlan(input, signal())).toBe(false)
  })
  it('keeps valid low-confidence routing inside Jev and rejects invalid confidence', async () => {
    const low = answer()
    low.answers.decision.confidence = .5
    expect(await setup(low).provider.shouldPlan(input, signal())).toBe(true)
    for (const confidence of [-1, 1.1]) {
      const body = answer()
      body.answers.decision.confidence = confidence
      expect(await setup(body).provider.shouldPlan(input, signal())).toBeUndefined()
    }
    const body = answer('plan', { plan: .8, direct: .2 })
    body.answers.decision.confidence = .99
    expect(await setup(body).provider.shouldPlan(input, signal())).toBe(true)
  })
  it.each([
    answer('plan',{plan:1.1,direct:-.1}),
    answer('plan',{plan:.98}),
    answer('unexpected',{plan:1,direct:0}),
    {...answer(),model:'another-model'},
    {answers:{}},
    answer('plan',{plan:.2,direct:.8}),
  ])('abstains on malformed responses', async body => {
    expect(await setup(body).provider.shouldPlan(input,signal())).toBeUndefined()
  })
  it('uses conservative PlanReview instead of LLM fallback for low confidence or margin', async () => {
    const confidence = setup(answer('direct',{plan:.4,direct:.6}))
    expect(await confidence.provider.shouldPlan(input,signal())).toBe(true)
    expect(confidence.report).toHaveBeenCalledWith('accepted:plan-low-confidence')
    const margin = setup(answer('plan',{plan:.7,direct:.3}),{...defaults,minConfidence:.6,minMargin:.5})
    expect(await margin.provider.shouldPlan(input,signal())).toBe(true)
    expect(margin.report).toHaveBeenCalledWith('accepted:plan-low-confidence')
  })
  it('does not send oversized or credential-less requests', async () => {
    const s = setup()
    s.key.mockResolvedValue(undefined as never)
    expect(await s.provider.shouldPlan(input,signal())).toBeUndefined()
    expect(s.fetcher).not.toHaveBeenCalled()
    const large = setup(answer(),{...defaults,maxInputBytes:100})
    expect(await large.provider.shouldPlan(input,signal())).toBeUndefined()
    expect(large.fetcher).not.toHaveBeenCalled()
  })
  it('opens and later recovers the circuit, without logging raw errors', async () => {
    vi.useFakeTimers()
    const s = setup()
    s.fetcher.mockRejectedValue(new Error('test-credential secret-tool-result'))
    for(let i=0;i<4;i++) expect(await s.provider.shouldPlan(input,signal())).toBeUndefined()
    expect(s.fetcher).toHaveBeenCalledTimes(3)
    expect(JSON.stringify(s.report.mock.calls)).not.toContain('test-credential')
    await vi.advanceTimersByTimeAsync(30001)
    s.fetcher.mockResolvedValue(Response.json(answer()))
    expect(await s.provider.shouldPlan(input,signal())).toBe(true)
  })
  it('abstains on 429 and malformed JSON without retrying', async () => {
    const s = setup()
    s.fetcher.mockResolvedValueOnce(new Response('too many',{status:429})).mockResolvedValueOnce(new Response('not-json'))
    expect(await s.provider.shouldPlan(input,signal())).toBeUndefined()
    expect(await s.provider.shouldPlan(input,signal())).toBeUndefined()
    expect(s.fetcher).toHaveBeenCalledTimes(2)
  })
  it('sends only the step criterion and MCP result; uncertain pauses', async () => {
    const s = setup(answer('uncertain',{success:0,failure:0,uncertain:1}))
    expect(await s.provider.assessStep(step,signal())).toMatchObject({status:'uncertain'})
    const body = JSON.parse(s.fetcher.mock.calls[0]![1]!.body as string)
    expect(body.questions.decision.criteria.success).toContain(step.criterion)
    expect(Object.keys(body.state).sort()).toEqual(['criterion', 'result'])
    expect(body.state.result).toEqual({started:true})
  })
  it('uses the supplied workflow criterion directly', async () => {
    const criterion = 'Beam-centre distance is at most 0.02 field half-widths.'
    const s = setup(answer('success',{success:.98,failure:.01,uncertain:.01}))
    await s.provider.assessStep({...step,criterion},signal())
    const body = JSON.parse(s.fetcher.mock.calls[0]![1]!.body as string)
    expect(body.questions.decision.criteria.success).toContain(criterion)
  })
  it('turns low-confidence step assessment into uncertain instead of LLM fallback', async () => {
    const s = setup(answer('success',{success:.6,failure:.2,uncertain:.2}))
    expect(await s.provider.assessStep(step,signal())).toMatchObject({status:'uncertain'})
  })
  it.each(['success','failure'])('accepts confident %s without invented evidence', async choice => {
    const s = setup(answer(choice,{success:choice==='success'?1:0,failure:choice==='failure'?1:0,uncertain:0}))
    expect(await s.provider.assessStep(step,signal())).toMatchObject({status:choice})
  })
  it('does not replace the judge without current-step criteria', async () => {
    const s = setup()
    expect(await s.provider.assessStep({...step,criterion:''},signal())).toBeUndefined()
    expect(s.fetcher).not.toHaveBeenCalled()
  })
  it('redacts explicit nested secret fields without dropping other evidence', () => {
    expect(sanitize({api_key:'secret', rows:[{password:'secret',result:'ok'}]})).toEqual({api_key:'[REDACTED]',rows:[{password:'[REDACTED]',result:'ok'}]})
  })
})

describe('workflow extension lifecycle', () => {
  it('reports Jev start and missing credentials without leaking request data', async () => {
    const registry = new DecisionExtensions()
    registry.register(new JevDecisions(async () => undefined))
    const events: unknown[] = []
    expect(await registry.run('assessStep', step, async status => { events.push(status) })).toBeUndefined()
    expect(events).toEqual([
      { provider: 'Jev', phase: 'started', reason: undefined },
      { provider: 'Jev', phase: 'fallback', reason: 'fallback:missing-credential' },
    ])
  })
  it('reports timeout once and ignores late provider decisions', async () => {
    vi.useFakeTimers()
    const registry = new DecisionExtensions()
    let finish!: (value: boolean) => void
    registry.register({ name: 'Jev', shouldPlan: async () => new Promise<boolean>(resolve => { finish = resolve }), assessStep: async () => undefined }, 100)
    const events: any[] = []
    const pending = registry.run('shouldPlan', input, async status => { events.push(status) })
    await vi.advanceTimersByTimeAsync(101)
    expect(await pending).toBeUndefined()
    expect(events[1]).toEqual({ provider: 'Jev', phase: 'fallback', reason: 'timeout-100ms' })
    finish(true)
    await vi.advanceTimersByTimeAsync(1)
    expect(events).toHaveLength(2)
  })
  it('keeps concurrent decision diagnostics separate and accepts uncertainty without fallback', async () => {
    const registry = new DecisionExtensions()
    registry.register({ name: 'Jev', shouldPlan: async (_i, _s, report) => { report?.('fallback:missing-credential'); return undefined },
      assessStep: async (_i, _s, report) => { report?.('accepted:uncertain'); return { status: 'uncertain', reason: 'Ambiguous evidence' } } })
    const router: any[] = [], judge: any[] = []
    await Promise.all([
      registry.run('shouldPlan', input, async status => { router.push(status) }),
      registry.run('assessStep', step, async status => { judge.push(status) }),
    ])
    expect(router[1].reason).toBe('fallback:missing-credential')
    expect(judge[1]).toEqual({ provider: 'Jev', phase: 'accepted', reason: 'accepted:uncertain' })
  })
  it('has no provider by default; unregister is idempotent and cannot remove a replacement', async () => {
    const registry = new DecisionExtensions()
    expect(await registry.run('shouldPlan',input)).toBeUndefined()
    const provider = {shouldPlan:vi.fn(async()=>true),assessStep:vi.fn(async()=>undefined)}
    const remove = registry.register(provider)
    expect(() => registry.register(provider)).toThrow('already registered')
    expect(await registry.run('shouldPlan',input)).toBe(true)
    remove(); registry.register({...provider,shouldPlan:async()=>false}); remove()
    expect(await registry.run('shouldPlan',input)).toBe(false)
  })
  it('bounds hung requests and rejects late results', async () => {
    vi.useFakeTimers()
    const registry = new DecisionExtensions()
    let resolve!: (value:boolean)=>void
    let receivedSignal!: AbortSignal
    registry.register({shouldPlan:(_input,s)=>{receivedSignal=s;return new Promise(r=>{resolve=r})},assessStep:async()=>undefined},100)
    const pending = registry.run('shouldPlan',input)
    await vi.advanceTimersByTimeAsync(101)
    expect(await pending).toBeUndefined()
    expect(receivedSignal.aborted).toBe(true)
    resolve(true)
  })
  it('falls back immediately during unload and contains throws and invalid results', async () => {
    const registry = new DecisionExtensions()
    const remove = registry.register({shouldPlan:()=>new Promise(()=>{}),assessStep:async()=>undefined})
    const pending = registry.run('shouldPlan',input)
    remove()
    expect(await pending).toBeUndefined()
    const remove2 = registry.register({shouldPlan:async()=>{throw new Error('broken')},assessStep:async()=>({status:'uncertain',reason:'unknown'})})
    expect(await registry.run('shouldPlan',input)).toBeUndefined()
    expect(await registry.run('assessStep',step)).toEqual({status:'uncertain',reason:'unknown'})
    remove2()
  })
  it('does not allow a provider to mutate workflow inputs', async () => {
    const registry = new DecisionExtensions()
    registry.register({shouldPlan:async i=>{i.query='mutated';return false},assessStep:async()=>undefined})
    await registry.run('shouldPlan',input)
    expect(input.query).toBe('Acquire a 4D-STEM dataset')
  })
  it('loads only with dependencies and unregisters when disposed', async () => {
    const ctx = new Context()
    const register = vi.fn(()=>vi.fn())
    const fiber = ctx.plugin(plugin,{apiKeyRef:'TYPESAFE_API_KEY'})
    await fiber.await()
    expect(register).not.toHaveBeenCalled()
    ctx.provide('credentials',{resolve:async()=>undefined})
    ctx.provide('edmorePlanJudge',{registerDecisionProvider:register})
    await fiber.await()
    expect(register).toHaveBeenCalledTimes(1)
    await fiber.dispose()
    expect(register.mock.results[0]!.value).toHaveBeenCalledTimes(1)
  })
})
