import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm,readFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {WikiAccounts} from '../src/wiki-accounts.mjs'
import {writeJson,Accounts} from '../src/store.mjs'
import {startAuthGateway} from '../src/index.mjs'

for(const research of [false,true])test(`native Wiki identities isolate users and provision public read access (research=${research})`,async t=> {
  const home=await mkdtemp(join(tmpdir(),'wiki-native-'));t.after(()=>rm(home,{recursive:true,force:true}))
  const configuration=join(home,'provision.json')
  await writeJson(configuration,{baseUrl:'http://wiki.test',email:'owner@test',password:'owner-secret',sharedKnowledgeBaseId:'public',...(research?{researchKnowledgeBaseId:'research'}:{}),personalModels:{embedding:'emb',synthesis:'gpt',vision:'vision'}})
  const users=[],kbs=[],members=[],shares=[],keys=[]
  const wiki=new WikiAccounts({home,configuration,fetchImpl:async(url,options)=> {
    const path=new URL(url).pathname.replace('/api/v1',''),body=options.body&&JSON.parse(options.body)
    const token=(options.headers.Authorization||'').slice(7)
    const tenant=token==='admin'?1:Number(token.replace('user-',''))
    const response=data=>Response.json({data})
    if(path==='/auth/login') {
      if(body.email==='owner@test')return Response.json({token:'admin'})
      const user=users.find(u=>u.email===body.email&&u.password===body.password)
      assert.ok(user);return Response.json({token:'user-'+user.tenant_id,user:{id:user.id,tenant_id:user.tenant_id,username:user.username},tenant:{id:user.tenant_id}})
    }
    if(path==='/system/admin/users/create') {assert.equal(token,'admin');const user={...body,id:'user-'+users.length,tenant_id:users.length+2};users.push(user);return Response.json({user})}
    if(path==='/knowledge-bases/public')return response({id:'public',tenant_id:1,indexing_strategy:{wiki_enabled:true},wiki_config:{}})
    if(path==='/models')return response([{id:'emb',is_builtin:true},{id:'gpt',is_builtin:true},{id:'vision',is_builtin:true}])
    if(path==='/organizations')return response(options.method==='POST'?{id:'org',name:body.name}:[])
    if(path==='/organizations/org/members')return response({members,total:members.length})
    if(path==='/organizations/org/invite'){assert.ok(!members.some(m=>m.tenant_id===body.tenant_id),'existing membership must not be invited twice');members.push(body);return response(body)}
    if(['/knowledge-bases/public/shares','/knowledge-bases/research/shares'].includes(path)){if(options.method==='POST')shares.push({...body,path});return response(options.method==='POST'?body:{shares:shares.filter(s=>s.path===path),total:shares.length})}
    if(path==='/knowledge-bases') {
      if(options.method==='POST'){const kb={...body,id:'kb-'+kbs.length,tenant_id:tenant};kbs.push(kb);return response(kb)}
      return response(kbs.filter(k=>k.tenant_id===tenant))
    }
    if(/\/api-keys$/.test(path)){const key={...body,tenant_id:tenant,token:'key-'+keys.length};keys.push(key);return response(key)}
    throw new Error('Unexpected request: '+path)
  }})
  const [alice,bob]=await Promise.all([wiki.ensure('alice'),wiki.ensure('bob')])
  assert.notEqual(alice.WEKNORA_API_KEY,bob.WEKNORA_API_KEY)
  assert.notEqual(alice.WEKNORA_RUNS_KB_ID,bob.WEKNORA_RUNS_KB_ID)
  assert.equal(kbs.length,research?8:6)
  for(const kb of kbs) {
    assert.equal(kb.image_processing_config.model_id,'vision')
    assert.deepEqual(kb.vlm_config,{enabled:true,model_id:'vision',description_language:'en-US'})
  }
  assert.ok(!alice.WEKNORA_KNOWLEDGE_BASE_IDS.includes('public'))
  assert.equal(shares.length,research?2:1);assert.equal(shares[0].permission,'viewer')
  if(research){assert.equal(alice.WEKNORA_RESEARCH_KB_ID,'research');assert.ok(alice.WEKNORA_DOCUMENTS_KB_ID);assert.ok(keys.some(k=>k.capabilities.length===1&&k.knowledge_base_ids.includes('research')))}
  assert.equal(members.length,2);assert.ok(members.every(m=>m.role==='viewer'))
  const before=keys.length;await wiki.ensure('alice');assert.equal(keys.length,before)
  const state=JSON.parse(await readFile(join(home,'auth/wiki/alice.native.json'),'utf8'))
  assert.ok(!JSON.stringify(alice).includes(state.identity.password))
  assert.ok(!JSON.stringify(alice).includes('admin'))
})

test('Wiki browser proxy binds requests to Harness identity and revokes disabled users',async t=> {
  const home=await mkdtemp(join(tmpdir(),'wiki-browser-'));let gateway
  t.after(async()=>{await gateway?.close();await rm(home,{recursive:true,force:true})})
  const accounts=new Accounts(join(home,'auth/accounts.json'))
  await accounts.change(s=>s.create('alice','long-test-password',true))
  await writeJson(join(home,'auth/users/alice/plugins.json'),{'edmore-wiki':true})
  await writeJson(join(home,'auth/wiki/alice.native.json'),{knowledgeBases:{Capabilities:'own-kb'}})
  const wiki={browser:async username=>({token:'secret-'+username,user:{id:username,username,tenant_id:2}}),settings:{baseUrl:'http://127.0.0.1:1'}}
  gateway=await startAuthGateway({home,workspace:join(home,'workspace'),root:resolve('.'),shared:[],port:0,host:'127.0.0.1',wiki})
  const call=(path,cookie,payload)=>fetch(gateway.origin+path,{redirect:'manual',method:payload?'POST':'GET',headers:{origin:gateway.origin,'content-type':'application/json',...(cookie?{cookie}:{})},...(payload?{body:JSON.stringify(payload)}:{})})
  assert.equal((await call('/auth/wiki/open')).status,401)
  const login=await call('/auth/login',null,{username:'alice',password:'long-test-password'})
  const cookie=login.headers.get('set-cookie').split(';')[0]
  const html=await call('/auth/wiki/open',cookie).then(r=>r.text())
  assert.ok(html.includes('own-kb'));assert.ok(!html.includes('secret-alice'))
  assert.equal((await call('/api/v1/system/admin/users/create',cookie,{})).status,403)
  assert.equal((await call('/api/v1/auth/login',cookie,{})).status,403)
  assert.equal((await call('/api/v1/chat',cookie,{})).status,403)
  await accounts.change(s=>s.setDisabled('alice',true))
  assert.equal((await call('/api/v1/knowledge-bases',cookie)).status,401)
})

test('public Wiki editors track active Harness administrators, not ordinary users',async t=> {
  const home=await mkdtemp(join(tmpdir(),'wiki-editors-'));t.after(()=>rm(home,{recursive:true,force:true}))
  const organization={id:'editors',owner_tenant_id:1}
  await writeJson(join(home,'auth/wiki/public-editors-organization.json'),organization)
  await writeJson(join(home,'auth/accounts.json'),[{username:'admin',isAdmin:true},{username:'reader',isAdmin:false},{username:'disabled',isAdmin:true,disabled:true}])
  for(const [username,tenantId]of [['admin',2],['reader',3],['disabled',4]])await writeJson(join(home,'auth/wiki',username+'.native.json'),{tenantId})
  const members=[{tenant_id:1,role:'admin'},{tenant_id:3,role:'editor'},{tenant_id:4,role:'editor'}],shares=[]
  const wiki=new WikiAccounts({home});wiki.settings={sharedKnowledgeBaseId:'public'}
  wiki.request=async(path,method='GET',body)=> {
    if(path==='/organizations/editors/members')return {members:[...members]}
    if(method==='DELETE'){const id=Number(path.split('/').at(-1));assert.notEqual(id,1);members.splice(members.findIndex(m=>m.tenant_id===id),1);return}
    if(path==='/organizations/editors/invite'){members.push(body);return body}
    if(path==='/knowledge-bases/public/shares'){if(method==='POST')shares.push(body);return {shares}}
    throw new Error('Unexpected request '+method+' '+path)
  }
  await wiki.reconcilePublicEditors();await wiki.reconcilePublicEditors()
  assert.deepEqual(members,[{tenant_id:1,role:'admin'},{tenant_id:2,role:'editor'}])
  assert.deepEqual(shares,[{organization_id:'editors',permission:'editor'}])
  await writeJson(join(home,'auth/accounts.json'),[{username:'admin',isAdmin:false}])
  await wiki.reconcilePublicEditors()
  assert.deepEqual(members,[{tenant_id:1,role:'admin'}])
})
