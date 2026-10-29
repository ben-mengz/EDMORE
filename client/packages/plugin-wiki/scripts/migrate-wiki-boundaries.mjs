import {join} from 'node:path'
import {readFile,writeFile,mkdir,rename} from 'node:fs/promises'
import {parseEnv} from 'node:util'
import {setTimeout as sleep} from 'node:timers/promises'
import {createHash} from 'node:crypto'
import {WikiAccounts} from '../src/wiki-accounts.mjs'
import {readJson,writeJson} from '@edmore/plugin-host/storage'

const home=process.env.DSH_HOME||'/data',configuration=process.env.EDMORE_WIKI_PROVISION_CONFIG||'/wiki-data/provision.json'
const wiki=new WikiAccounts({home,configuration})
await wiki.login()
const apply=process.argv.includes('--apply')
const reportPath=join(home,'auth/wiki/boundary-migration.json')
const report=await readJson(reportPath,{moves:[],removedDuplicates:[],preserved:[]})
async function list(token,kb) {
  const rows=[]
  for(let page=1;;page++) {
    const result=await wiki.nativeRequest(token,`/knowledge-bases/${kb}/knowledge?page_size=100&page=${page}`)
    rows.push(...result.data||[])
    if(!result.data?.length||rows.length>=result.total)return rows
  }
}
const shared=await wiki.request('/knowledge-bases/'+wiki.settings.sharedKnowledgeBaseId)
let research=wiki.settings.researchKnowledgeBaseId&&await wiki.request('/knowledge-bases/'+wiki.settings.researchKnowledgeBaseId)
let publicRows=await list(wiki.token,shared.id)
console.log(JSON.stringify({shared:shared.id,research:research?.id,documents:publicRows.length}))
if(!apply)process.exit(0)
if(!research) {
  const kbs=await wiki.request('/knowledge-bases')
  research=kbs.find(k=>k.name==='Shared - Research Library')
  if(!research) {
    const fields=['type','embedding_model_id','summary_model_id','chunking_config','indexing_strategy','wiki_config','image_processing_config','vlm_config','storage_config','question_generation_config']
    research=await wiki.request('/knowledge-bases','POST',{...Object.fromEntries(fields.filter(k=>shared[k]!==undefined).map(k=>[k,shared[k]])),name:'Shared - Research Library',description:'Public papers, equipment manuals and scientific reference documents. Administrator-maintained; read-only for other users.',profile_config:{enabled:false},auto_tag_config:{enabled:false}})
  }
  wiki.settings.researchKnowledgeBaseId=research.id
  await writeJson(configuration,wiki.settings)
}
await wiki.request('/knowledge-bases/'+shared.id,'PUT',{name:'Shared - Harness Reference',description:'Server-managed Skills, public MCP schemas, Harness documentation and knowledge governance. Not a research-document library.'})
await configureImportPaths()
if(process.argv.includes('--prepare')){console.log(JSON.stringify({prepared:true,research:research.id}));process.exit(0)}
const move=publicRows.filter(r=>r.channel!=='edmore-capability-sync'&&r.channel!=='edmore-governance'&&!/^EDMORE Imported File deployment(?:\.md)?$/.test(r.title||''))
if(move.length) {
  report.plannedReferenceIds=[...new Set([...(report.plannedReferenceIds||[]),...move.map(r=>r.id)])]
  await writeJson(reportPath,report)
  const response=await wiki.request('/knowledge/move','POST',{source_kb_id:shared.id,target_kb_id:research.id,knowledge_ids:move.map(r=>r.id),mode:'reuse_vectors'})
  report.moves.push({...response,ids:move.map(r=>r.id)})
  await writeJson(reportPath,report)
}
for(const task of report.moves) {
  let result
  for(let attempt=0;attempt<180;attempt++) {
    result=await wiki.request('/knowledge/move/progress/'+task.task_id)
    if(['completed','failed'].includes(result.status))break
    await sleep(1000)
  }
  console.log(JSON.stringify({move:task.task_id,result}))
  if(result.status!=='completed')throw new Error('Reference migration is incomplete; rerun to resume')
}
const researchRows=await list(wiki.token,research.id)
for(const task of report.moves)for(const id of task.ids)if(!researchRows.some(r=>r.id===id))throw new Error('Moved source identity was not preserved')
for(const id of report.plannedReferenceIds||[])if(!researchRows.some(r=>r.id===id))throw new Error('Planned reference is missing')
// An explicit public import destination is separate from the capability mirror.
async function configureImportPaths() {
const envPath=join(process.env.WEKNORA_DATA_DIR||'/wiki-data','harness.env')
const env=parseEnv(await readFile(envPath,'utf8'))
const harnessImports=join(process.env.WEKNORA_SYNC_DIR||'/wiki-sync','harness')
await mkdir(harnessImports,{recursive:true,mode:0o700})
try {await rename(join(env.WEKNORA_IMPORT_DIR,'deployment.md'),join(harnessImports,'deployment.md'))}catch(error){if(error.code!=='ENOENT')throw error}
env.WEKNORA_HARNESS_IMPORT_DIR=harnessImports
env.WEKNORA_BOUNDARY_MIGRATION_REPORT=reportPath
if(env.WEKNORA_RESEARCH_KB_ID!==research.id) {
  const key=await wiki.request(`/tenants/${shared.tenant_id}/api-keys`,'POST',{name:'EDMORE public libraries synchronization',full_access:false,knowledge_base_ids:[shared.id,research.id],capabilities:['retrieve','ingest']})
  env.WEKNORA_API_KEY=key.token;env.WEKNORA_RESEARCH_KB_ID=research.id
  env.WEKNORA_CAPABILITIES_KB_ID=shared.id;env.WEKNORA_KNOWLEDGE_BASE_IDS=[shared.id,research.id].join(',')
}
await writeFile(envPath,Object.entries(env).map(([k,v])=>`${k}=${JSON.stringify(v)}`).join('\n')+'\n',{mode:0o600})
}
publicRows=await list(wiki.token,shared.id)
const publicContents=new Map()
const adminSettings=await readJson(join(home,'auth/admin/settings.json'),{mcp:[]})
const sharedMcp=new Set(adminSettings.mcp.filter(row=>row.scope==='shared').map(row=>row.id))
const normalize=text=>text.replace(/^<!-- edmore-source-sha256: [a-f0-9]+ -->\s*/,'').replace(/^- (Source|Provider):.*$/gm,'').trim()
for(const row of publicRows.filter(r=>r.channel==='edmore-capability-sync')) {
  const detail=await wiki.request('/knowledge/'+row.id)
  if(typeof detail.metadata?.content==='string')publicContents.set(row.title,normalize(detail.metadata.content))
}
for(const account of await readJson(join(home,'auth/accounts.json'),[])) {
  if(account.disabled)continue
  await wiki.ensure(account.username)
  const state=await readJson(join(home,'auth/wiki',account.username+'.native.json'))
  const session=await wiki.browser(account.username)
  const own=async(...args)=>(await wiki.nativeRequest(session.token,...args))?.data
  const descriptions={Capabilities:'Private custom Skills and MCP documentation only; public definitions are retrieved from Shared - Harness Reference.',Documents:'Private uploaded documents. Upload to Shared - Research Library only when intentionally publishing for everyone.',Runs:'Private workflow outcomes and event evidence, including failures and cancellations.',Conversations:'Private conversation history; never automatically published to shared libraries.'}
  for(const [kind,id] of Object.entries(state.knowledgeBases))await own('/knowledge-bases/'+id,'PUT',{name:kind==='Capabilities'?'Personal - Custom Capabilities':`Personal - ${kind}`,description:descriptions[kind]})
  const rows=await list(session.token,state.knowledgeBases.Capabilities)
  const uploads=rows.filter(r=>!['edmore-capability-sync','edmore-governance'].includes(r.channel))
  if(uploads.length) {
    const task=await own('/knowledge/move','POST',{source_kb_id:state.knowledgeBases.Capabilities,target_kb_id:state.knowledgeBases.Documents,knowledge_ids:uploads.map(r=>r.id),mode:'reuse_vectors'})
    let progress
    for(let attempt=0;attempt<180;attempt++) {
      progress=await own('/knowledge/move/progress/'+task.task_id)
      if(['completed','failed'].includes(progress.status))break
      await sleep(1000)
    }
    if(progress.status!=='completed')throw new Error('Private document migration incomplete for '+account.username)
    const moved=await list(session.token,state.knowledgeBases.Documents)
    if(uploads.some(r=>!moved.some(m=>m.id===r.id)))throw new Error('Private upload identity mismatch')
    report.privateDocuments??=[];report.privateDocuments.push({username:account.username,ids:uploads.map(r=>r.id)})
  }
  for(const row of rows.filter(r=>r.channel==='edmore-capability-sync')) {
    const detail=await own('/knowledge/'+row.id)
    const content=detail.metadata?.content
    const generated=typeof content==='string'&&content.match(/^<!-- edmore-source-sha256: ([a-f0-9]{64}) -->\n\n([\s\S]*)$/)
    const server=row.title?.match(/\[MCP:([^\]]+)\]/)?.[1]
    const obsoleteSharedMcp=server&&sharedMcp.has(decodeURIComponent(server))&&publicContents.has(row.title)&&generated&&createHash('sha256').update('wiki-sources-v1\0').update(generated[2]).digest('hex')===generated[1]
    if(typeof content!=='string'||(normalize(content)!==publicContents.get(row.title)&&!obsoleteSharedMcp)) {
      if(!report.preserved.some(item=>item.id===row.id))report.preserved.push({username:account.username,id:row.id,title:row.title,reason:'Not an exact public-source duplicate'});continue
    }
    // Back up the entire original before native deletion retracts derived Wiki claims.
    await writeJson(join(home,'auth/wiki/boundary-backup',account.username,row.id+'.json'),detail)
    await own('/knowledge/'+row.id,'DELETE')
    report.removedDuplicates.push({username:account.username,id:row.id,title:row.title})
    report.preserved=report.preserved.filter(item=>item.id!==row.id)
    await writeJson(reportPath,report)
  }
  const refs=await own('/shared-knowledge-bases')
  const visible=Array.isArray(refs)?refs:refs?.knowledge_bases||refs?.items||[]
  for(const id of [shared.id,research.id]) {
    const matches=visible.filter(r=>(r.knowledge_base?.id||r.id||r.knowledge_base_id)===id)
    const permissions=matches.map(r=>r.my_permission||r.permission)
    if(!permissions.includes(account.isAdmin?'editor':'viewer')||(!account.isAdmin&&permissions.some(p=>p!=='viewer')))throw new Error('Shared permission verification failed')
  }
  console.log(JSON.stringify({user:account.username,privateLibraries:Object.keys(state.knowledgeBases),publicLibraries:2,permission:account.isAdmin?'editor':'viewer'}))
}
const text=await readFile(new URL('../docs/wiki-knowledge-boundaries.md',import.meta.url),'utf8')
const existing=publicRows.find(r=>r.channel==='edmore-governance'&&r.title==='EDMORE Knowledge Boundaries')
await wiki.request(existing?'/knowledge/manual/'+existing.id:`/knowledge-bases/${shared.id}/knowledge/manual`,existing?'PUT':'POST',{title:'EDMORE Knowledge Boundaries',content:text,status:'publish',channel:'edmore-governance',process_config:{summary_enabled:false,question_generation_config:{enabled:false},graph_enabled:false,enable_multimodel:false}})
report.completedAt=new Date().toISOString();report.researchKnowledgeBaseId=research.id
await writeJson(reportPath,report)
console.log(JSON.stringify({completed:true,research:research.id,moved:researchRows.length,removedDuplicates:report.removedDuplicates.length,preserved:report.preserved.length}))
