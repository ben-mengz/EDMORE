import {readFile,writeFile,chmod} from 'node:fs/promises'
import {resolve,join,isAbsolute} from 'node:path'
import {parseEnv} from 'node:util'
import {DatabaseSync,backup} from 'node:sqlite'

const deployment=resolve(process.argv[2])
const envPath=join(deployment,process.argv[3]||'server.env')
const settings=parseEnv(await readFile(envPath,'utf8'))
const address='http://127.0.0.1:'+(settings.SERVER_PORT||'8080')
let running=false
try {running=(await fetch(address+'/health',{signal:AbortSignal.timeout(1500)})).ok}catch{}
if(running)throw new Error('Stop the Wiki backend before migrating queued document languages')
if(settings.DB_DRIVER!=='sqlite')throw new Error('This migration is for the native SQLite deployment')
const database=isAbsolute(settings.DB_PATH)?settings.DB_PATH:resolve(deployment,settings.DB_PATH)
const db=new DatabaseSync(database)
const backupPath=database+'.before-english-'+Date.now()
try {
  await backup(db,backupPath)
  await chmod(backupPath,0o600)
  db.exec('BEGIN IMMEDIATE')
  try {
    const result=db.prepare("UPDATE task_pending_ops SET payload=json_set(payload, '$.language', 'en-US') WHERE task_type='wiki:ingest' AND json_valid(payload) AND coalesce(json_extract(payload,'$.language'),'') != 'en-US'").run()
    db.exec('COMMIT')
    settings.WEKNORA_LANGUAGE='en-US'
    await writeFile(envPath,Object.entries(settings).map(([key,value])=>key+'='+JSON.stringify(value)).join('\n')+'\n',{mode:0o600})
    console.log(JSON.stringify({documentLanguage:'en-US',updatedPendingTasks:result.changes,backupCreated:true}))
  } catch(error) {
    if(db.isTransaction)db.exec('ROLLBACK')
    throw error
  }
} finally {db.close()}
