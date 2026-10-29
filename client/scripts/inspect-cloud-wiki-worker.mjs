import {readdir,readFile,readlink} from 'node:fs/promises'
import {createReadStream} from 'node:fs'
import {join} from 'node:path'

const username=process.env.EDMORE_WIKI_OWNER||'zhaomeng'
const home=join(process.env.DSH_HOME||'/data','auth/users',username)
async function readProc(path) {
  let value=''
  for await(const chunk of createReadStream(path,{encoding:'utf8'}))value+=chunk
  return value
}
let worker
if(process.env.EDMORE_INSPECT_PORT) {
  let input=''
  for await(const chunk of process.stdin)input+=chunk
  const env=Object.fromEntries(input.split('\0').filter(Boolean).map(row=> {const i=row.indexOf('=');return [row.slice(0,i),row.slice(i+1)]}))
  if(env.EDMORE_AUTH_WORKER!=='1'||env.DSH_HOME!==home)throw new Error('Input is not the requested owner worker')
  worker={pid:process.env.EDMORE_INSPECT_PID,env}
}
for(const pid of worker?[]:await readdir('/proc')) {
  if(!/^\d+$/.test(pid))continue
  try {
    const env=Object.fromEntries((await readProc(`/proc/${pid}/environ`)).split('\0').filter(Boolean).map(row=> {const i=row.indexOf('=');return [row.slice(0,i),row.slice(i+1)]}))
    if(env.EDMORE_AUTH_WORKER==='1'&&env.DSH_HOME===home)worker={pid,env}
  } catch{}
}
if(!worker)throw new Error('Cannot inspect an owner worker; check host process visibility and proc permissions')
const sockets=new Set()
for(const fd of process.env.EDMORE_INSPECT_PORT?[]:await readdir(`/proc/${worker.pid}/fd`)) {
  try {const match=/^socket:\[(\d+)\]$/.exec(await readlink(`/proc/${worker.pid}/fd/${fd}`));if(match)sockets.add(match[1])}catch{}
}
const ports=new Set(process.env.EDMORE_INSPECT_PORT?[Number(process.env.EDMORE_INSPECT_PORT)]:[])
for(const file of process.env.EDMORE_INSPECT_PORT?[]:['tcp','tcp6'])for(const line of (await readFile(`/proc/${worker.pid}/net/${file}`,'utf8')).split('\n').slice(1)) {
  const fields=line.trim().split(/\s+/)
  if(fields[3]==='0A'&&sockets.has(fields[9]))ports.add(parseInt(fields[1].split(':')[1],16))
}
let tools
for(const port of ports) {
  try {
    const r=await fetch(`http://127.0.0.1:${port}/api/edmore/harness/tools?include=wiki`,{headers:{'x-edmore-worker-token':worker.env.EDMORE_WORKER_TOKEN},signal:AbortSignal.timeout(5000)})
    if(r.ok){tools=(await r.json()).tools;break}
  }catch{}
}
if(!tools)throw new Error('Live worker API was not found')
const names=tools.map(tool=>tool.name).filter(name=>name.startsWith('weknora_'))
for(const name of ['weknora_wiki_search','weknora_shared_wiki_search','weknora_runs_wiki_search','weknora_conversations_wiki_search'])if(!names.includes(name))throw new Error('Missing live Wiki tool: '+name)
const history=JSON.parse(await readFile(join(home,'edmore/weknora-history.json'),'utf8'))
const documents=Object.values(history.documents)
const sources=[]
for(const [kind,kb]of [['capabilities',worker.env.WEKNORA_CAPABILITIES_KB_ID],['runs',worker.env.WEKNORA_RUNS_KB_ID],['conversations',worker.env.WEKNORA_CONVERSATIONS_KB_ID]]) {
  const r=await fetch(worker.env.WEKNORA_BASE_URL+`/api/v1/knowledge-bases/${kb}/knowledge?page_size=100`,{headers:{'X-API-Key':worker.env.WEKNORA_API_KEY},signal:AbortSignal.timeout(10000)})
  if(!r.ok)throw new Error('Scoped user knowledge API failed: '+r.status)
  const response=await r.json()
  sources.push({kind,total:response.total,completed:response.data.filter(doc=>doc.parse_status==='completed').length,processing:response.data.filter(doc=>doc.parse_status!=='completed').length})
}
console.log(JSON.stringify({user:username,workerPid:Number(worker.pid),wikiTools:names,mcpTools:tools.filter(tool=>tool.name.startsWith('mcp__')).length,historyCursor:history.cursor,historyDocuments:documents.length,acknowledged:documents.filter(doc=>doc.digest).length,sources}))
