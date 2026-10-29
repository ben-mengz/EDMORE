import {randomBytes} from 'node:crypto'
import {join} from 'node:path'
import {UserWiki} from './wiki.mjs'
import {readJson,writeJson} from '@edmore/plugin-host/storage'

// Native users own separate tenants. The old shared-tenant records remain an
// archive; references are copied, never deleted, before switching worker scope.
export class WikiAccounts extends UserWiki {
  constructor(options) { super(options); this.browserSessions=new Map(); this.queue=Promise.resolve() }
  ensure(username) {
    if(!/^[a-zA-Z0-9_-]{1,32}$/.test(username))throw new Error('Invalid Wiki user identity')
    if(this.pending.has(username))return this.pending.get(username)
    const work=this.queue.then(()=>this.provision(username)).finally(()=>this.pending.delete(username))
    this.queue=work.catch(()=>{});this.pending.set(username,work)
    return work
  }
  async nativeRequest(token,path,method='GET',body) {
    const r=await this.fetchImpl(this.settings.baseUrl+'/api/v1'+path,{method,
      headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},
      body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(60000)})
    if(!r.ok)throw new Error(`Personal Wiki request failed: ${method} ${path}: HTTP ${r.status}`)
    return r.status===204?undefined:await r.json()
  }
  async identity(username,state,path) {
    state.identity??={username:'edmore_'+username,email:`edmore-${username}@harness.invalid`,password:'Aa1!'+randomBytes(20).toString('base64url')}
    if(!state.identity.id)state.identity.password=('Aa1!'+state.identity.password.replace(/^Aa1!/, '')).slice(0,32)
    await writeJson(path,state)
    if(!state.identity.id) {
      const created=await this.nativeRequest(this.token,'/system/admin/users/create','POST',state.identity)
      if(!created.user?.id||!created.user.tenant_id)throw new Error('Wiki account must have a personal tenant')
      state.identity.id=created.user.id;state.tenantId=created.user.tenant_id
      await writeJson(path,state)
    }
    const login=await this.nativeRequest('', '/auth/login','POST',{email:state.identity.email,password:state.identity.password})
    if(!login.token||login.user?.id!==state.identity.id||login.user?.tenant_id!==state.tenantId)throw new Error('Personal Wiki identity mismatch')
    this.browserSessions.set(username,{...login,expires:Date.now()+5*60_000})
    return login
  }
  async provision(username) {
    await this.login()
    const path=join(this.home,'auth/wiki',username+'.native.json')
    const state=await readJson(path,{version:2,knowledgeBases:{}})
    if(state.sharedKnowledgeBaseId&&state.sharedKnowledgeBaseId!==this.settings.sharedKnowledgeBaseId)throw new Error('Public Wiki scope changed')
    state.sharedKnowledgeBaseId=this.settings.sharedKnowledgeBaseId
    const session=await this.identity(username,state,path)
    const own=async(...args)=>(await this.nativeRequest(session.token,...args))?.data
    const template=await this.request('/knowledge-bases/'+state.sharedKnowledgeBaseId)
    const models=this.settings.personalModels
    if(!models?.embedding||!models?.synthesis)throw new Error('Personal Wiki built-in models are not configured')
    const available=await own('/models')
    for(const id of [models.embedding,models.synthesis,models.vision].filter(Boolean))if(!available.some(m=>m.id===id&&m.is_builtin))throw new Error('Personal Wiki requires platform models')
    let organization=await readJson(join(this.home,'auth/wiki/public-organization.json'))
    if(!organization) {
      const organizations=await this.request('/organizations')
      organization=(Array.isArray(organizations)?organizations:organizations?.organizations||organizations?.items||[]).find(o=>o.name==='EDMORE Public Wiki')
      organization??=await this.request('/organizations','POST',{name:'EDMORE Public Wiki',member_limit:0})
      await writeJson(join(this.home,'auth/wiki/public-organization.json'),organization)
    }
    const members=await this.request(`/organizations/${organization.id}/members`)
    if(!(Array.isArray(members)?members:members?.members||[]).some(m=>m.tenant_id===state.tenantId))await this.request(`/organizations/${organization.id}/invite`,'POST',{tenant_id:state.tenantId,role:'viewer'})
    const publicIds=[state.sharedKnowledgeBaseId,this.settings.researchKnowledgeBaseId].filter(Boolean)
    for(const kb of publicIds) {
      const shares=await this.request(`/knowledge-bases/${kb}/shares`)
      if(!(Array.isArray(shares)?shares:shares?.shares||[]).some(s=>s.organization_id===organization.id&&s.permission==='viewer'))await this.request(`/knowledge-bases/${kb}/shares`,'POST',{organization_id:organization.id,permission:'viewer'})
    }
    await this.reconcilePublicEditors()
    const rows=await own('/knowledge-bases')
    for(const kind of ['Capabilities','Runs','Conversations',...(this.settings.researchKnowledgeBaseId?['Documents']:[])]) {
      if(state.knowledgeBases[kind])continue
      const name=kind==='Capabilities'?'Personal - Custom Capabilities':`Personal - ${kind}`
      const kb=rows.find(k=>k.name===name)||await own('/knowledge-bases','POST',{
        name,type:'document',description:`Personal ${kind.toLowerCase()} evidence for ${username}.`,
        embedding_model_id:models.embedding,summary_model_id:models.synthesis,
        ...(models.vision?{image_processing_config:{model_id:models.vision},vlm_config:{enabled:true,model_id:models.vision,description_language:'en-US'}}:{}),
        chunking_config:template.chunking_config,indexing_strategy:template.indexing_strategy,
        wiki_config:{...template.wiki_config,synthesis_model_id:models.synthesis},profile_config:{enabled:false},auto_tag_config:{enabled:false},
      })
      if(kb.tenant_id!==state.tenantId)throw new Error('Personal Wiki tenant mismatch')
      state.knowledgeBases[kind]=kb.id;await writeJson(path,state)
    }
    const ids=Object.values(state.knowledgeBases)
    for(const [field,capabilities]of [['readKey',['retrieve']],['syncKey',['retrieve','ingest']]]) {
      if(state[field]&&JSON.stringify(state.privateKeyKnowledgeBaseIds||ids)===JSON.stringify(ids)&&(!this.settings.researchKnowledgeBaseId||state.privateKeyKnowledgeBaseIds))continue
      const key=await own(`/tenants/${state.tenantId}/api-keys`,'POST',{name:`EDMORE ${field}`,full_access:false,knowledge_base_ids:ids,capabilities})
      if(!key.token)throw new Error('Personal Wiki returned no scoped key')
      state[field]=key.token;await writeJson(path,state)
    }
    state.privateKeyKnowledgeBaseIds=ids
    if(!state.sharedReadKey||(this.settings.researchKnowledgeBaseId&&JSON.stringify(state.sharedReadKnowledgeBaseIds)!==JSON.stringify(publicIds))) {
      const key=await this.request(`/tenants/${template.tenant_id}/api-keys`,'POST',{name:`EDMORE Public read ${username}`,full_access:false,knowledge_base_ids:publicIds,capabilities:['retrieve']})
      if(!key.token)throw new Error('Public Wiki returned no read key')
      state.sharedReadKey=key.token;state.sharedReadKnowledgeBaseIds=publicIds
    }
    await writeJson(path,state)
    await this.migrate(username,state,path,own)
    return {
      EDMORE_USER_WIKI:'1',WEKNORA_BASE_URL:this.settings.baseUrl,WEKNORA_API_KEY:state.readKey,WEKNORA_SYNC_API_KEY:state.syncKey,
      WEKNORA_SHARED_API_KEY:state.sharedReadKey,WEKNORA_SHARED_KB_ID:template.id,WEKNORA_KNOWLEDGE_BASE_IDS:ids.join(','),
      WEKNORA_RESEARCH_KB_ID:this.settings.researchKnowledgeBaseId||'',WEKNORA_DOCUMENTS_KB_ID:state.knowledgeBases.Documents||'',
      WEKNORA_CAPABILITIES_KB_ID:state.knowledgeBases.Capabilities,WEKNORA_RUNS_KB_ID:state.knowledgeBases.Runs,
      WEKNORA_CONVERSATIONS_KB_ID:state.knowledgeBases.Conversations,WEKNORA_HISTORY_ENABLED:'1',
      WEKNORA_HISTORY_STATE_PATH:join(this.home,'auth/users',username,'edmore/weknora-history-native.json'),
    }
  }
  async migrate(username,state,path,own) {
    if(state.migrated)return
    const old=await readJson(join(this.home,'auth/wiki',username+'.json'))
    state.copied??={}
    for(const [kind,kb]of Object.entries(old?.knowledgeBases||{})) {
      for(let page=1;;page++) {
        const result=await this.nativeRequest(this.token,`/knowledge-bases/${kb}/knowledge?page_size=100&page=${page}`)
        for(const source of result.data||[]) {
          if(state.copied[source.id])continue
          const detail=await this.request('/knowledge/'+source.id)
          if(typeof detail.metadata?.content!=='string')throw new Error('Non-manual source requires administrator migration')
          const existing=await own(`/knowledge-bases/${state.knowledgeBases[kind]}/knowledge?page_size=100`)
          if(!existing.some(d=>d.title===source.title&&d.channel===source.channel))await own(`/knowledge-bases/${state.knowledgeBases[kind]}/knowledge/manual`,'POST',{
            title:source.title,content:detail.metadata.content,status:'publish',channel:source.channel,
            process_config:{summary_enabled:false,question_generation_config:{enabled:false},graph_enabled:false,enable_multimodel:false,image_attrs_enabled:false},
          })
          state.copied[source.id]=true;await writeJson(path,state)
        }
        if(!result.data?.length||page*100>=result.total)break
      }
    }
    state.migrated=true;await writeJson(path,state)
  }
  async reconcilePublicEditors() {
    // A separate editor grant leaves the public reader organization unchanged.
    // Never infer administrator status from the browser or a Wiki username.
    const accounts=await readJson(join(this.home,'auth/accounts.json'),[])
    const allowed=new Set()
    for(const account of accounts) {
      if(account.isAdmin!==true||account.disabled)continue
      const native=await readJson(join(this.home,'auth/wiki',account.username+'.native.json'))
      if(native?.tenantId)allowed.add(native.tenantId)
    }
    const path=join(this.home,'auth/wiki/public-editors-organization.json')
    let organization=await readJson(path)
    if(!organization) {
      if(!allowed.size)return
      const result=await this.request('/organizations')
      organization=(Array.isArray(result)?result:result?.organizations||result?.items||[]).find(o=>o.name==='EDMORE Public Wiki Editors')
      organization??=await this.request('/organizations','POST',{name:'EDMORE Public Wiki Editors',member_limit:0,require_approval:true})
      await writeJson(path,organization)
    }
    const result=await this.request(`/organizations/${organization.id}/members`)
    const members=Array.isArray(result)?result:result?.members||[]
    for(const member of members) {
      // The provisioning tenant owns the organization, not a Harness account.
      if(member.tenant_id===organization.owner_tenant_id)continue
      if(!allowed.has(member.tenant_id))await this.request(`/organizations/${organization.id}/members/${member.tenant_id}`,'DELETE')
      else if(member.role!=='editor')await this.request(`/organizations/${organization.id}/members/${member.tenant_id}`,'PUT',{role:'editor'})
    }
    for(const tenantId of allowed)if(!members.some(m=>m.tenant_id===tenantId))await this.request(`/organizations/${organization.id}/invite`,'POST',{tenant_id:tenantId,role:'editor'})
    for(const kb of [this.settings.sharedKnowledgeBaseId,this.settings.researchKnowledgeBaseId].filter(Boolean)) {
      const shares=await this.request(`/knowledge-bases/${kb}/shares`)
      const shared=(Array.isArray(shares)?shares:shares?.shares||[]).find(s=>s.organization_id===organization.id)
      if(!shared)await this.request(`/knowledge-bases/${kb}/shares`,'POST',{organization_id:organization.id,permission:'editor'})
      else if(shared.permission!=='editor')throw new Error('Public Wiki editor share has unexpected permissions')
    }
  }
  async browser(username) {
    if(!this.browserSessions.get(username)||this.browserSessions.get(username).expires<Date.now())await this.ensure(username)
    return this.browserSessions.get(username)
  }
}
