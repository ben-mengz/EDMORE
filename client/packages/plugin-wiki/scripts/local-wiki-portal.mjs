import { readFile, writeFile, rename } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { homedir } from 'node:os'
import { parseEnv } from 'node:util'
import { randomBytes } from 'node:crypto'
import { WikiAccounts } from '../src/wiki-accounts.mjs'
import { startLocalWikiPortal } from '../src/local-portal.mjs'

if (!process.send) throw new Error('The local Wiki portal must be launched by the desktop IPC owner')
const root = resolve(process.argv[2])
const configuration = join(root, 'provision.json')
const settings = JSON.parse(await readFile(configuration, 'utf8'))
const home = resolve(process.env.DSH_HOME || join(homedir(), '.dsh'))
const wiki = new WikiAccounts({ home, configuration })
const scoped = await wiki.ensure(settings.localOwner)
const envPath = join(root, 'harness.env')
const previous = parseEnv(await readFile(envPath, 'utf8'))
const env = { ...previous, ...scoped }
// Credentials stay in a private local file, never in browser URLs or plugin archives.
const temporary = `${envPath}.${randomBytes(8).toString('hex')}.tmp`
await writeFile(temporary, Object.entries(env).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join('\n') + '\n', { mode: 0o600 })
await rename(temporary, envPath)
const portal = await startLocalWikiPortal({ wiki, username: settings.localOwner, home })
process.send({ type: 'wiki-portal-ready', url: portal.entry() })
process.on('message', value => { if (value?.type === 'entry') process.send({ type: 'wiki-portal-entry', url: portal.entry() }) })
process.on('disconnect', () => { void portal.close() })
process.on('SIGTERM', () => { void portal.close().then(() => process.exit(0)) })
