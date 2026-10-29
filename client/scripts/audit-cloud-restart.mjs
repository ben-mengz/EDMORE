import {readdir,readFile} from 'node:fs/promises'
import {createReadStream} from 'node:fs'
import {join} from 'node:path'

const home=process.env.DSH_HOME||'/data'
const activeWorkers=[]
let processVisibilityIncomplete=false
async function readProc(path) {
  let value=''
  for await(const chunk of createReadStream(path,{encoding:'utf8'}))value+=chunk
  return value
}
for(const pid of await readdir('/proc')) {
  if(!/^\d+$/.test(pid))continue
  try {
    const environment=Object.fromEntries((await readProc(`/proc/${pid}/environ`)).split('\0').filter(Boolean).map(row=>{const i=row.indexOf('=');return [row.slice(0,i),row.slice(i+1)]}))
    if(environment.EDMORE_AUTH_WORKER==='1'&&environment.DSH_HOME?.startsWith(home+'/auth/users/'))activeWorkers.push({pid:Number(pid),user:environment.DSH_HOME.slice((home+'/auth/users/').length)})
  } catch(error) {if(error.code==='EACCES'||error.code==='EPERM')processVisibilityIncomplete=true}
}
const users=[]
for(const username of await readdir(join(home,'auth/users'))) {
  const responses=new Set(),workflows=new Map()
  let lastTimestamp
  const rows=(await readFile(join(home,'auth/users',username,'edmore/events.jsonl'),'utf8')).split('\n').filter(Boolean)
  for(const row of rows) {
    const event=JSON.parse(row);lastTimestamp=event.timestamp
    if(event.type==='edmore.assistant.started')responses.add(event.payload?.response_id)
    if(['edmore.assistant.completed','edmore.assistant.failed'].includes(event.type))responses.delete(event.payload?.response_id)
    if(event.workflow_id&&event.type.startsWith('edmore.workflow.'))workflows.set(event.workflow_id,event.type)
  }
  users.push({username,lastTimestamp,unfinishedResponses:responses.size,lastWorkflowEvents:[...workflows.values()],liveWorker:activeWorkers.some(worker=>worker.user===username)})
}
console.log(JSON.stringify({activeWorkers,processVisibilityIncomplete,users}))
if(processVisibilityIncomplete||users.some(user=>user.liveWorker&&user.unfinishedResponses))process.exitCode=2
