import { describe, it, expect, vi } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HistorySync, projectEvent, redact } from '../src/history.ts'

const event=(cursor:number,type:string,payload:Record<string,unknown>={},workflow_id?:string)=>({cursor,event_id:`event-${cursor}`,timestamp:'2026-09-30T12:00:00Z',type,payload,session_id:'NOMAD-example',workflow_id})
describe('Wiki historical source projection',()=>{
  it('redacts structured and prose credentials before persistence',()=>{
    const value=JSON.stringify(redact({api_key:'private',password:'private',text:'password is abc123 密码是Zm_123456 token=foobar Bearer verysecret sk-abcdefghijklmnop',nested:{authorization:'private'}}))
    for(const secret of ['private','abc123','Zm_123456','foobar','verysecret','sk-abcdefghijklmnop'])expect(value).not.toContain(secret)
    expect(value).toContain('REDACTED')
  })
  it('excludes hidden model output, deltas, heartbeat and test sessions',()=>{
    expect(projectEvent(event(1,'edmore.assistant.completed',{hidden:true,text:'private reasoning'}))).toBeUndefined()
    expect(projectEvent(event(2,'edmore.assistant.delta',{text:'delta'}))).toBeUndefined()
    expect(projectEvent(event(3,'edmore.server.heartbeat'))).toBeUndefined()
    expect(projectEvent({...event(4,'edmore.trigger.requested',{prompt:'synthetic'}),session_id:'codex-test'})).toBeUndefined()
    expect(projectEvent(event(5,'edmore.assistant.completed',{text:'It worked'}))?.text).toContain('unverified statements')
  })
  it('persists pending uploads, retries across restart, and does not repeat acknowledged sources',async()=>{
    const dir=await mkdtemp(join(tmpdir(),'wiki-history-'))
    try {
      const events=[event(1,'edmore.workflow.started',{},'wf-one'),event(2,'edmore.custom.harness_tool_result',{is_error:false,text:'timeout; result unknown'}),event(3,'edmore.workflow.paused',{reason:'verify outcome'},'wf-one'),event(4,'edmore.trigger.requested',{prompt:'password=secret123 what happened?'})]
      const hub={ready:async()=>{},query:({after,limit}:{after:number;limit:number})=>events.filter(e=>e.cursor>after).slice(0,limit)}
      const publisher={publishReference:vi.fn().mockRejectedValue(new Error('offline'))}
      const options={path:join(dir,'state.json'),runsKB:'runs',conversationsKB:'chat',batchSize:20}
      const first=await new HistorySync(hub,publisher,options).sync()
      expect(first.cursor).toBe(4);expect(first.pending).toBe(3)
      const persisted=await readFile(options.path,'utf8')
      expect(persisted).not.toContain('secret123');expect(persisted).toContain('edmore.workflow.paused')
      publisher.publishReference.mockResolvedValue(true)
      const restarted=new HistorySync(hub,publisher,options)
      expect((await restarted.sync()).pending).toBe(0)
      publisher.publishReference.mockClear()
      await restarted.sync();expect(publisher.publishReference).not.toHaveBeenCalled()
      events.push(event(5,'edmore.workflow.failed',{reason:'failed verification'},'wf-one'))
      await restarted.sync();expect(publisher.publishReference).toHaveBeenCalledTimes(2)
      expect(publisher.publishReference.mock.calls.map(c=>c[2]).join('\n')).toContain('edmore.workflow.failed')
    } finally {await rm(dir,{recursive:true,force:true})}
  })
  it('does not acknowledge a document whose native processing is deferred',async()=>{
    const dir=await mkdtemp(join(tmpdir(),'wiki-history-'))
    try {
      const e=event(1,'edmore.trigger.requested',{prompt:'hello'})
      const sync=new HistorySync({ready:async()=>{},query:({after})=>after?[]:[e]}, {publishReference:async()=>false}, {path:join(dir,'state.json'),runsKB:'runs',conversationsKB:'chat'})
      expect((await sync.sync()).pending).toBe(1)
      expect((await sync.sync()).pending).toBe(1)
    }finally{await rm(dir,{recursive:true,force:true})}
  })
})
