import {WikiAccounts} from '../src/wiki-accounts.mjs'
import {readJson} from '@edmore/plugin-host/storage'
import {join} from 'node:path'
import {WeKnoraKnowledgeClient} from '@deepseek-ai/dsh-edmore-weknora-sync'
const home=process.env.DSH_HOME||'/data'
const wiki=new WikiAccounts({home,configuration:process.env.EDMORE_WIKI_PROVISION_CONFIG||'/wiki-data/provision.json'})
await wiki.login()
for(const account of await readJson(join(home,'auth/accounts.json'),[])) {
  if(account.disabled)continue
  const state=await readJson(join(home,'auth/wiki',account.username+'.native.json'))
  const session=await wiki.nativeRequest('','/auth/login','POST',{email:state.identity.email,password:state.identity.password})
  const own=(await wiki.nativeRequest(session.token,'/knowledge-bases')).data
  console.log(JSON.stringify({user:account.username,private:own.map(k=>({id:k.id,name:k.name,type:k.type,tenant_id:k.tenant_id}))}))
  if(own.some(k=>k.tenant_id!==state.tenantId))throw new Error('Tenant isolation failed')
  for(const id of [wiki.settings.sharedKnowledgeBaseId,wiki.settings.researchKnowledgeBaseId]) {
    const rows=(await wiki.nativeRequest(session.token,`/knowledge-bases/${id}/knowledge?page_size=100`)).data
    const source=rows.find(r=>r.type==='manual'||r.file_type==='md'||r.channel)
    const response=await fetch(wiki.settings.baseUrl+'/api/v1/knowledge/manual/'+source.id,{method:'PUT',headers:{Authorization:'Bearer '+session.token,'Content-Type':'application/json'},body:'{',signal:AbortSignal.timeout(10000)})
    if(response.status!==(account.isAdmin?400:403))throw new Error(`Unexpected write gate ${account.username}: ${response.status}`)
    console.log(JSON.stringify({user:account.username,kb:id,documents:rows.length,writeGate:response.status}))
  }
  if(account.username==='zhaomeng') {
    const client=new WeKnoraKnowledgeClient(wiki.settings.baseUrl,state.sharedReadKey,undefined,30000)
    const result=await client.searchReferences(wiki.settings.researchKnowledgeBaseId,'Talos eucentric')
    if(!result.data?.length||result.data.some(r=>r.knowledge_base_id!==wiki.settings.researchKnowledgeBaseId))throw new Error('Research retrieval scope failed')
    console.log(JSON.stringify({researchRetrieval:{matches:result.data.length,titles:[...new Set(result.data.map(r=>r.knowledge_title))]}}))
  }
}
