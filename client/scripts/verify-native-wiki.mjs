import {WikiAccounts} from '../packages/auth/src/wiki-accounts.mjs'
import {readJson} from '../packages/auth/src/store.mjs'
import {join} from 'node:path'
const home=process.env.DSH_HOME||'/data',username=process.env.EDMORE_WIKI_OWNER||'zhaomeng'
const wiki=new WikiAccounts({home,configuration:process.env.WEKNORA_PROVISION_FILE||'/wiki-data/provision.json'})
const env=await wiki.ensure(username)
const state=await readJson(join(home,'auth/wiki',username+'.native.json'))
const session=await wiki.browser(username)
const own=await wiki.nativeRequest(session.token,'/knowledge-bases')
if(own.data.some(k=>k.tenant_id!==state.tenantId))throw new Error('Private list contains another tenant')
const shared=await wiki.nativeRequest(session.token,'/shared-knowledge-bases')
const r=await fetch(wiki.settings.baseUrl+'/api/v1/knowledge-bases/'+state.sharedKnowledgeBaseId,{method:'PUT',headers:{Authorization:'Bearer '+session.token,'Content-Type':'application/json'},body:JSON.stringify({name:'EDMORE Cloud Capabilities'})})
if(r.status!==403)throw new Error('Public Wiki mutation was not denied: '+r.status)
const read=await wiki.nativeRequest(session.token,'/knowledge-bases/'+state.sharedKnowledgeBaseId)
if(!read.data)throw new Error('Public Wiki is not readable')
console.log(JSON.stringify({username,nativeAccount:state.identity.username,tenantId:state.tenantId,personalKnowledgeBases:own.data.length,copiedReferences:Object.keys(state.copied||{}).length,sharedVisible:Boolean(shared.data),sharedWriteDenied:r.status,privateScopes:env.WEKNORA_KNOWLEDGE_BASE_IDS.split(',').length}))
