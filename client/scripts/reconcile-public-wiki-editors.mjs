import {join} from 'node:path'
import {WikiAccounts} from '../packages/auth/src/wiki-accounts.mjs'
import {readJson} from '../packages/auth/src/store.mjs'

const home=process.env.DSH_HOME||'/data'
const wiki=new WikiAccounts({home,configuration:process.env.EDMORE_WIKI_PROVISION_CONFIG||'/wiki-data/provision.json'})
await wiki.login()
await wiki.reconcilePublicEditors()
for(const account of await readJson(join(home,'auth/accounts.json'),[])) {
  if(account.disabled)continue
  const state=await readJson(join(home,'auth/wiki',account.username+'.native.json'))
  if(!state)continue
  const session=await wiki.nativeRequest('','/auth/login','POST',{email:state.identity.email,password:state.identity.password})
  const result=await wiki.nativeRequest(session.token,'/shared-knowledge-bases')
  const data=result.data
  const rows=Array.isArray(data)?data:data?.knowledge_bases||data?.items||[]
  const publicRows=rows.filter(row=>(row.knowledge_base?.id||row.id||row.knowledge_base_id)===wiki.settings.sharedKnowledgeBaseId)
  const permissions=publicRows.map(row=>row.my_permission||row.permission)
  const expected=account.isAdmin?'editor':'viewer'
  if(!permissions.includes(expected)||(!account.isAdmin&&permissions.some(p=>p!=='viewer')))throw new Error(`Unexpected public Wiki permissions for ${account.username}: ${JSON.stringify(permissions)}`)
  console.log(JSON.stringify({username:account.username,publicWiki:expected,verified:true}))
}
