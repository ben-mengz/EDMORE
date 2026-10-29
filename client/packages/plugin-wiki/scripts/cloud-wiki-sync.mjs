import { mkdir, writeFile, rename } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { WeKnoraKnowledgeClient } from '@deepseek-ai/dsh-edmore-weknora-sync'
import {publicCapabilities} from './public-wiki-capabilities.mjs'
import {readFile} from 'node:fs/promises'
import {readJson} from '@edmore/plugin-host/storage'

const env = process.env
if (!env.WEKNORA_BASE_URL || !env.WEKNORA_API_KEY || !env.WEKNORA_CAPABILITIES_KB_ID || !env.WEKNORA_RESEARCH_KB_ID || !env.WEKNORA_IMPORT_DIR) {
  throw new Error('Cloud Wiki directory synchronization requires scoped settings')
}
const controller = new AbortController()
process.on('SIGTERM', () => controller.abort())
process.on('SIGINT', () => controller.abort())
const client = new WeKnoraKnowledgeClient(env.WEKNORA_BASE_URL, env.WEKNORA_API_KEY, undefined, 30000, fetch, controller.signal)
const statusFile = join(env.WEKNORA_SYNC_DIR || '/wiki-sync', 'checkpoints/imports.json')
await mkdir(dirname(statusFile), {recursive:true, mode:0o700})
let lastDocuments
while (!controller.signal.aborted) {
  try {
    if(env.WEKNORA_BOUNDARY_MIGRATION_REPORT&&!(await readJson(env.WEKNORA_BOUNDARY_MIGRATION_REPORT,{})).completedAt) {
      await sleep(1000,undefined,{signal:controller.signal});continue
    }
    const documents = await client.syncImportDirectory(env.WEKNORA_RESEARCH_KB_ID, env.WEKNORA_IMPORT_DIR)
    const snapshot=await publicCapabilities(process.cwd(),env.DSH_HOME||'/data',AbortSignal.any([controller.signal,AbortSignal.timeout(60000)]))
    await client.syncSources(env.WEKNORA_CAPABILITIES_KB_ID,'EDMORE Capability Catalog',snapshot)
    if(env.WEKNORA_HARNESS_IMPORT_DIR)await client.syncImportDirectory(env.WEKNORA_CAPABILITIES_KB_ID,env.WEKNORA_HARNESS_IMPORT_DIR)
    await client.upsertManualKnowledge(env.WEKNORA_CAPABILITIES_KB_ID,'EDMORE Knowledge Boundaries',await readFile(new URL('../docs/wiki-knowledge-boundaries.md',import.meta.url),'utf8'),'edmore-governance')
    await writeFile(statusFile+'.tmp', JSON.stringify({phase:'submitted',documents,updatedAt:new Date().toISOString()})+'\n', {mode:0o600})
    await rename(statusFile+'.tmp',statusFile)
    if (documents !== lastDocuments) console.log(`Wiki directory synchronization submitted: ${documents} source(s)`)
    lastDocuments = documents
  } catch {
    if (controller.signal.aborted) break
    console.error('Wiki directory synchronization failed; retrying on the next poll')
  }
  try {await sleep(30000,undefined,{signal:controller.signal})} catch {break}
}
