import { readFile } from 'node:fs/promises'
import { parseEnv } from 'node:util'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

export async function startWikiServices({ launch, stopping = () => false, env = process.env, fetchImpl = fetch }) {
  const root = env.WEKNORA_DATA_DIR || '/wiki-data'
  const settings = parseEnv(await readFile(`${root}/server.env`, 'utf8'))
  const url = `http://127.0.0.1:${settings.SERVER_PORT || '8080'}`
  let occupied = false
  try { occupied = (await fetchImpl(`${url}/health`, { signal: AbortSignal.timeout(1000) })).ok } catch {}
  if (occupied) throw new Error('WeKnora port is already owned by another process')
  const wiki = launch('WeKnora', env.WEKNORA_BINARY || '/opt/weknora/WeKnora-lite', [], {
    cwd: env.WEKNORA_SERVICE_ROOT || '/opt/weknora', env: { ...env, ...settings },
  })
  let ready = false
  const deadline = Date.now() + Number(env.EDMORE_WIKI_STARTUP_TIMEOUT_MS || 180_000)
  while (Date.now() < deadline && !stopping()) {
    if (wiki.exitCode !== null || wiki.signalCode !== null) break
    try { ready = (await fetchImpl(`${url}/health`, { signal: AbortSignal.timeout(1000) })).ok } catch {}
    if (ready) break
    await sleep(500)
  }
  if (!ready) throw new Error('WeKnora did not become ready')
  const harnessEnv = { ...env, ...parseEnv(await readFile(`${root}/harness.env`, 'utf8')) }
  if (!stopping() && harnessEnv.EDMORE_AUTH === '1' && harnessEnv.WEKNORA_IMPORT_DIR && harnessEnv.WEKNORA_API_KEY) {
    launch('Wiki directory sync', process.execPath,
      ['--import', 'tsx/esm', fileURLToPath(new URL('../scripts/cloud-wiki-sync.mjs', import.meta.url))], { env: harnessEnv })
  }
  return harnessEnv
}
