import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm,stat,readFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {createServer} from 'node:http'
import {once} from 'node:events'
import {setTimeout as sleep} from 'node:timers/promises'
import {UserWiki} from '../src/wiki.mjs'
import {writeJson,Accounts} from '../src/store.mjs'
import {startAuthGateway} from '../src/index.mjs'

test('Wiki provisions separate user scopes, keeps shared KB read-only and reuses saved credentials',async t=> {
  const home=await mkdtemp(join(tmpdir(),'edmore-user-wiki-'))
  t.after(()=>rm(home,{recursive:true,force:true}))
  const configuration=join(home,'private.json')
  await writeJson(configuration,{baseUrl:'http://wiki.test',email:'owner@test',password:'private-admin-password',sharedKnowledgeBaseId:'shared'})
  const kbs=[{id:'shared',name:'Shared',tenant_id:1,indexing_strategy:{wiki_enabled:true},wiki_config:{synthesis_model_id:'gpt'}}]
  const keys=[]
  const wiki=new UserWiki({home,configuration,fetchImpl:async(url,options)=> {
    const path=new URL(url).pathname
    const body=options.body&&JSON.parse(options.body)
    if(path.endsWith('/auth/login'))return Response.json({token:'administrator-only-token'})
    assert.equal(options.headers.Authorization,'Bearer administrator-only-token')
    if(path.endsWith('/knowledge-bases/shared'))return Response.json({data:kbs[0]})
    if(path.endsWith('/knowledge-bases')) {
      if(options.method==='POST'){const row={...body,id:'kb-'+kbs.length,tenant_id:1};kbs.push(row);return Response.json({data:row})}
      return Response.json({data:kbs})
    }
    if(path.endsWith('/api-keys')) {
      if(options.method==='POST'){const row={...body,id:'key-'+keys.length,token:'scoped-'+keys.length};keys.push(row);return Response.json({data:row})}
      return Response.json({data:keys})
    }
    throw new Error('Unexpected request')
  }})
  const [alice,aliceAgain]=await Promise.all([wiki.ensure('alice'),wiki.ensure('alice')])
  assert.deepEqual(alice,aliceAgain)
  const bob=await wiki.ensure('bob')
  assert.notEqual(alice.WEKNORA_CAPABILITIES_KB_ID,bob.WEKNORA_CAPABILITIES_KB_ID)
  assert.notEqual(alice.WEKNORA_API_KEY,bob.WEKNORA_API_KEY)
  assert.equal(keys.length,4)
  for(const username of ['alice','bob']) {
    const read=keys.find(row=>row.name===`EDMORE User ${username} retrieval`)
    const sync=keys.find(row=>row.name===`EDMORE User ${username} synchronization`)
    assert.deepEqual(read.capabilities,['retrieve'])
    assert.ok(read.knowledge_base_ids.includes('shared'))
    assert.ok(!sync.knowledge_base_ids.includes('shared'))
    assert.equal(sync.knowledge_base_ids.length,3)
    assert.ok(!sync.knowledge_base_ids.includes(username==='alice'?bob.WEKNORA_RUNS_KB_ID:alice.WEKNORA_RUNS_KB_ID))
    assert.equal(read.full_access,false);assert.equal(sync.full_access,false)
    assert.equal((await stat(join(home,'auth/wiki',username+'.json'))).mode&0o777,0o600)
  }
  assert.ok(!JSON.stringify(alice).includes('private-admin-password'))
  assert.ok(!JSON.stringify(alice).includes('administrator-only-token'))
  assert.deepEqual(await wiki.ensure('alice'),alice)
  assert.equal(keys.length,4)
  assert.throws(()=>wiki.ensure('../bob'),/Invalid Wiki user/)
  await writeJson(configuration,{baseUrl:'http://wiki.test',email:'owner@test',password:'private-admin-password',sharedKnowledgeBaseId:'different'})
  await assert.rejects(wiki.ensure('alice'),/scope changed/)
})

test('real authenticated workers provision separate Wiki accounts by default and allow runtime opt-out', {timeout:120000},async t=> {
  const home=await mkdtemp(join(tmpdir(),'edmore-wiki-workers-'))
  const server=createServer((req,res)=> {res.setHeader('Content-Type','application/json');res.end(JSON.stringify({data:[],total:0}))})
  server.listen(0,'127.0.0.1');await once(server,'listening')
  let gateway
  t.after(async()=> {await gateway?.close();server.closeAllConnections();await new Promise(done=>server.close(done));await rm(home,{recursive:true,force:true})})
  const accounts=new Accounts(join(home,'auth/accounts.json'))
  for(const username of ['alice','bob'])await accounts.change(store=>store.create(username,'long-test-password',username==='alice'))
  const provisioned=[]
  gateway=await startAuthGateway({home,workspace:join(home,'workspace'),root:resolve('.'),port:0,host:'127.0.0.1',shared:[],wiki:{ensure:async username=> {
    if(!provisioned.includes(username))provisioned.push(username)
    return {EDMORE_USER_WIKI:'1',WEKNORA_BASE_URL:`http://127.0.0.1:${server.address().port}`,WEKNORA_API_KEY:'read-'+username,WEKNORA_SYNC_API_KEY:'write-'+username,
      WEKNORA_CAPABILITIES_KB_ID:username+'-capabilities',WEKNORA_SHARED_KB_ID:'shared',WEKNORA_KNOWLEDGE_BASE_IDS:'shared,'+username+'-capabilities',
      WEKNORA_RUNS_KB_ID:username+'-runs',WEKNORA_CONVERSATIONS_KB_ID:username+'-conversations',WEKNORA_HISTORY_ENABLED:'1'}
  }}})
  for(const username of ['alice','bob'])assert.equal(JSON.parse(await readFile(join(home,'auth/users',username,'plugins.json'),'utf8'))['edmore-wiki'],true)
  const alice=await gateway.workers.get('alice')
  const bob=await gateway.workers.get('bob')
  const tools=async entry=> {const r=await fetch(`http://127.0.0.1:${entry.port}/api/edmore/harness/tools?include=wiki`,{headers:{'x-edmore-worker-token':entry.token}});assert.equal(r.status,200);return (await r.json()).tools.map(tool=>tool.name)}
  let names=[]
  for(let attempt=0;attempt<40;attempt++) {names=await tools(alice);if(names.includes('weknora_shared_wiki_search'))break;await sleep(100)}
  for(const name of ['weknora_wiki_search','weknora_shared_wiki_search','weknora_runs_wiki_search','weknora_conversations_wiki_search'])assert.ok(names.includes(name),name)
  assert.ok((await tools(bob)).includes('weknora_conversations_wiki_search'))
  assert.deepEqual(provisioned,['alice','bob'])
  const login=await fetch(gateway.origin+'/auth/login',{method:'POST',headers:{origin:gateway.origin,'content-type':'application/json'},body:JSON.stringify({username:'alice',password:'long-test-password'})})
  assert.equal(login.status,200)
  const created=await fetch(gateway.origin+'/auth/users',{method:'POST',headers:{origin:gateway.origin,cookie:login.headers.get('set-cookie').split(';')[0],'content-type':'application/json'},body:JSON.stringify({action:'create',username:'carol',password:'long-test-password'})})
  assert.equal(created.status,200)
  assert.equal((await gateway.workers.plugins('carol')).find(plugin=>plugin.id==='edmore-wiki').enabled,true)
  const automatic=await gateway.workers.get('carol')
  assert.ok((await tools(automatic)).includes('weknora_conversations_wiki_search'))
  assert.deepEqual(provisioned,['alice','bob','carol'])
  await gateway.workers.setPlugin('alice','edmore-wiki',false)
  const disabled=await gateway.workers.get('alice')
  assert.ok(!(await tools(disabled)).some(name=>name.startsWith('weknora_')))
})
