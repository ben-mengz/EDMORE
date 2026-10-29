import {join} from 'node:path'
import {readJson,writeJson} from '@edmore/plugin-host/storage'

export class UserWiki {
  constructor({home,configuration,fetchImpl=fetch}) {
    Object.assign(this,{home,configuration,fetchImpl})
    this.pending=new Map()
  }
  ensure(username) {
    if(!/^[a-zA-Z0-9_-]{1,32}$/.test(username))throw new Error('Invalid Wiki user identity')
    if(this.pending.has(username))return this.pending.get(username)
    const work=this.provision(username).finally(()=>this.pending.delete(username))
    this.pending.set(username,work)
    return work
  }
  async request(path,method='GET',body) {
    const response=await this.fetchImpl(this.settings.baseUrl+'/api/v1'+path,{
      method,headers:{Authorization:'Bearer '+this.token,'Content-Type':'application/json'},
      body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(30000),
    })
    if(!response.ok)throw new Error(`Wiki provisioning failed: HTTP ${response.status}`)
    return response.status===204?undefined:(await response.json()).data
  }
  async login() {
    this.settings=await readJson(this.configuration)
    if(!this.settings?.baseUrl||!this.settings.email||!this.settings.password||!this.settings.sharedKnowledgeBaseId)throw new Error('Wiki provisioning settings are missing')
    if(this.token&&Date.now()<this.expires)return
    const response=await this.fetchImpl(this.settings.baseUrl+'/api/v1/auth/login',{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({email:this.settings.email,password:this.settings.password}),signal:AbortSignal.timeout(30000),
    })
    if(!response.ok)throw new Error('Wiki provisioning login failed')
    const result=await response.json()
    if(!result.token)throw new Error('Wiki provisioning returned no authorization')
    this.token=result.token;this.expires=Date.now()+10*60_000
  }
  async provision(username) {
    await this.login()
    const path=join(this.home,'auth','wiki',username+'.json')
    const state=await readJson(path,{version:1,knowledgeBases:{}})
    const shared=this.settings.sharedKnowledgeBaseId
    if(state.sharedKnowledgeBaseId&&state.sharedKnowledgeBaseId!==shared)throw new Error('Wiki scope changed; migrate user authorization before proceeding')
    state.sharedKnowledgeBaseId=shared
    if(!state.readKey||!state.syncKey) {
      const template=await this.request('/knowledge-bases/'+shared)
      const existing=await this.request('/knowledge-bases')
      const rows=Array.isArray(existing)?existing:existing?.items||[]
      for(const kind of ['Capabilities','Runs','Conversations']) {
        if(state.knowledgeBases[kind])continue
        const name=`EDMORE User ${username} ${kind}`
        const kb=rows.find(row=>row.name===name)||await this.request('/knowledge-bases','POST',{
          name,type:'document',description:`Private EDMORE ${kind.toLowerCase()} references for ${username}. Historical evidence, not execution authorization.`,
          embedding_model_id:template.embedding_model_id,summary_model_id:template.summary_model_id,
          chunking_config:template.chunking_config,indexing_strategy:template.indexing_strategy,wiki_config:template.wiki_config,
          profile_config:{enabled:false},auto_tag_config:{enabled:false},
        })
        if(kb.tenant_id!==template.tenant_id)throw new Error('Wiki provisioning tenant mismatch')
        state.tenantId=kb.tenant_id;state.knowledgeBases[kind]=kb.id
        await writeJson(path,state)
      }
      const privateIds=Object.values(state.knowledgeBases)
      const keys=await this.request(`/tenants/${state.tenantId}/api-keys`)
      for(const [field,label,ids,capabilities] of [
        ['readKey','retrieval',[shared,...privateIds],['retrieve']],
        ['syncKey','synchronization',privateIds,['retrieve','ingest']],
      ]) {
        if(state[field])continue
        const name=`EDMORE User ${username} ${label}`
        if(keys.some(key=>key.name===name))throw new Error('Wiki authorization exists without its saved credential; administrator recovery is required')
        const key=await this.request(`/tenants/${state.tenantId}/api-keys`,'POST',{name,full_access:false,knowledge_base_ids:ids,capabilities})
        if(!key.token)throw new Error('Wiki provisioning returned no scoped credential')
        state[field]=key.token;await writeJson(path,state)
      }
    }
    return {
      WEKNORA_BASE_URL:this.settings.baseUrl,WEKNORA_API_KEY:state.readKey,WEKNORA_SYNC_API_KEY:state.syncKey,
      WEKNORA_KNOWLEDGE_BASE_IDS:[shared,...Object.values(state.knowledgeBases)].join(','),
      WEKNORA_CAPABILITIES_KB_ID:state.knowledgeBases.Capabilities,WEKNORA_SHARED_KB_ID:shared,
      WEKNORA_RUNS_KB_ID:state.knowledgeBases.Runs,WEKNORA_CONVERSATIONS_KB_ID:state.knowledgeBases.Conversations,
      WEKNORA_HISTORY_ENABLED:'1',EDMORE_USER_WIKI:'1',
    }
  }
}
