import { describe, expect, it, vi } from 'vitest'
import { EdmoreWorkflow } from './workflow-fixture.ts'
import type { SkillRegistryReader } from '../src/skills.ts'

async function fixture() {
  const definition = { name:'test-wait', description:'Wait for readiness', content:'The wait must finish successfully.', provider:'fixture', source:'runtime',
    invocation:{modelInvocable:true,userInvocable:true}, metadata:{edmore:{authority:'workflow',workflow:{schema_version:1,id:'test_wait',version:'1',steps:[{
      id:'wait',title:'Wait',purpose:'Wait for readiness',tool:'agent_sem.wait',parameters:{seconds:{mode:'fixed',value:7}},confirm:false,
      completion:{type:'tool_success'},expected_output:'Finished waiting 7 seconds',on_success:'complete',on_failure:'pause',
    }]}}} }
  const registry = { snapshot:async()=>({complete:true,skills:[definition]}),get:async()=>structuredClone(definition) } as SkillRegistryReader
  const events: any[] = []
  const workflow = new EdmoreWorkflow({async append(event){ events.push(event); return {...event,event_id:'hub',cursor:1,timestamp:''} }}, {
    async status(){return {ok:true,agents:['agent_sem'],agentInfo:{},message:''}},
    async listTools(){return {tools:[{name:'wait',inputSchema:{type:'object',properties:{seconds:{type:'number'}}}}]}}}, '',undefined,0,registry)
  const original = vi.fn(async(_s:string, role:string) => role==='orchestrator' ? '{"needs_plan":true,"reason":"baseline"}' : '{"status":"uncertain","reason":"baseline judge"}')
  const plan = await workflow['generatePlan']('p','test-wait','s')
  workflow.bindRoleRunner({runRoleOnce:original})
  const event = {event_id:'q',cursor:0,timestamp:'',source:'test',type:'query',scope:'session',session_id:'s',payload:{}}
  return {workflow,original,event,events,plan}
}

describe('optional decision provider in the real workflow', () => {
  it('preserves the original router before registration and after disposal', async () => {
    const {workflow,original,event} = await fixture()
    expect(await workflow['shouldPlan']('query',event)).toBe(true)
    const dispose = workflow.registerDecisionProvider({shouldPlan:async()=>false,assessStep:async()=>undefined})
    expect(await workflow['shouldPlan']('query',event)).toBe(false)
    expect(original).toHaveBeenCalledTimes(1)
    dispose()
    expect(await workflow['shouldPlan']('query',event)).toBe(true)
    expect(original).toHaveBeenCalledTimes(2)
  })
  it('falls back to the exact existing roles on provider exceptions', async () => {
    const {workflow,original,event,plan} = await fixture()
    workflow.registerDecisionProvider({shouldPlan:async()=>{throw Error('provider')},assessStep:async()=>{throw Error('provider')}})
    expect(await workflow['shouldPlan']('query',event)).toBe(true)
    expect(await workflow['assessStepResult'](plan,plan.steps[0],{},'s','call')).toEqual({status:'uncertain',reason:'baseline judge'})
    expect(original.mock.calls.map(call=>call[1])).toEqual(['orchestrator','judge'])
  })
  it('passes only the current criterion and MCP result; provider uncertainty does not fall through', async () => {
    const {workflow,original,plan} = await fixture()
    const assessStep = vi.fn(async()=>({status:'uncertain' as const,reason:'unclear'}))
    workflow.registerDecisionProvider({shouldPlan:async()=>undefined,assessStep})
    expect(await workflow['assessStepResult'](plan,plan.steps[0],{finished:true},'s','call',true)).toEqual({status:'uncertain',reason:'unclear'})
    expect(assessStep.mock.calls[0]?.[0]).toEqual({criterion:expect.stringContaining(plan.steps[0].expected_output),result:{finished:true}})
    expect(original).not.toHaveBeenCalled()
  })
  it('can use the provider directly when the fallback LLM judge is unavailable', async () => {
    const {workflow,plan} = await fixture()
    workflow['roleRunner'] = undefined
    workflow.registerDecisionProvider({shouldPlan:async()=>undefined,assessStep:async()=>({status:'success',reason:'Jev criterion passed'})})
    expect(await workflow['assessStepResult'](plan,plan.steps[0],{finished:true},'s','call')).toEqual({status:'success',reason:'Jev criterion passed'})
  })
  it.each(['tool-error', 'missing-output'])('never lets provider success override %s', async kind => {
    const {workflow,original,events,plan} = await fixture()
    if (kind === 'missing-output') plan.steps[0].completion = {type:'field_present',field:'saved_path'}
    const assessStep = vi.fn(async()=>({status:'success' as const,reason:'model says success'}))
    workflow.registerDecisionProvider({shouldPlan:async()=>false,assessStep})
    workflow['activeBySession'].set('s',{plan,nextStepIndex:0})
    workflow.bindHarnessSession('h','s')
    const blocker = vi.spyOn(workflow as any,'handleRuntimeBlocker').mockResolvedValue(undefined)
    await workflow.afterLoopToolResult('h','agent_sem','wait','call',kind === 'tool-error'
      ? {isError:true,content:[{type:'text',text:'failed'}]}
      : {structuredContent:{started:true}})
    expect(events.find(e=>e.type==='edmore.custom.step_result.judged')?.payload).toMatchObject({status:'failure',hard_failure:true})
    expect(assessStep).not.toHaveBeenCalled()
    expect(original).not.toHaveBeenCalled()
    expect(blocker).toHaveBeenCalledTimes(1)
    expect(workflow['activeBySession'].get('s')?.nextStepIndex).toBe(0)
  })
  it('pauses the workflow when the provider is uncertain', async () => {
    const {workflow,events,plan} = await fixture()
    workflow.registerDecisionProvider({shouldPlan:async()=>false,assessStep:async()=>({status:'uncertain',reason:'Jev confidence is insufficient'})})
    workflow['activeBySession'].set('s',{plan,nextStepIndex:0})
    workflow.bindHarnessSession('h','s')
    const blocker = vi.spyOn(workflow as any,'handleRuntimeBlocker').mockResolvedValue(undefined)
    await workflow.afterLoopToolResult('h','agent_sem','wait','call',{content:[{type:'text',text:'wait returned'}]})
    expect(events.find(e=>e.type==='edmore.custom.step_result.judged')?.payload).toMatchObject({status:'uncertain',hard_failure:false})
    expect(blocker).toHaveBeenCalledTimes(1)
    expect(workflow['activeBySession'].get('s')?.nextStepIndex).toBe(0)
  })
  it('does not invoke the provider to bypass an unaccepted confirmation gate', async () => {
    const {workflow,plan} = await fixture()
    plan.steps[0].required_inputs=['Confirm ROI']
    workflow['activeBySession'].set('s',{plan,nextStepIndex:0})
    workflow.bindHarnessSession('h','s')
    const assessStep=vi.fn(async()=>({status:'success' as const,reason:'success'}))
    workflow.registerDecisionProvider({shouldPlan:async()=>false,assessStep})
    await expect(workflow.beforeLoopToolCall('h','agent_sem','wait',{seconds:7},'call')).rejects.toThrow('paused')
    expect(assessStep).not.toHaveBeenCalled()
  })
})
