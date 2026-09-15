import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'

// Keep the public profile launcher, including its shutdown/disposal policy.
const [root, profile, baseUrl, pluginPatch] = process.argv.slice(2)
const address = new URL(baseUrl)
const directory = mkdtempSync(join(tmpdir(), 'edmore-desktop-'))
const patch = join(directory, 'desktop.patch.yml')
writeFileSync(patch, JSON.stringify([{ id: 'webserver', config: { host: address.hostname, port: Number(address.port || 80) } }]))
process.once('exit', () => rmSync(directory, { recursive: true, force: true }))
let stopRequested = false
const stop = () => {
  if (stopRequested) return
  stopRequested = true
  if (process.listenerCount('SIGTERM') > 0) process.emit('SIGTERM')
}
process.on('message', message => { if (message?.type === 'shutdown') stop() })
process.once('disconnect', stop)
if (profile !== 'edmore-client') throw new Error('EDMORE Desktop requires the edmore-client profile')
process.argv = [process.execPath, join(root, 'start.mjs'), ...(pluginPatch ? ['--patch', pluginPatch] : []), '--patch', patch]
await import(pathToFileURL(join(root, 'start.mjs')).href)
if (stopRequested) process.emit('SIGTERM')
