import { spawn } from 'node:child_process'
import { loadFeatures } from '@edmore/plugin-host'
import { startWikiServices } from '../packages/plugin-wiki/src/services.mjs'

const children = new Set()
let stopping = false
async function stop(code = 0) {
  if (stopping) return
  stopping = true
  const exited = [...children].map(child => new Promise(resolve => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve()
    child.once('exit', resolve)
    try { process.kill(-child.pid, 'SIGTERM') } catch { child.kill('SIGTERM') }
  }))
  const timer = setTimeout(() => { for (const child of children) {
    try { process.kill(-child.pid, 'SIGKILL') } catch { child.kill('SIGKILL') }
  } }, 25000)
  await Promise.all(exited)
  clearTimeout(timer)
  process.exitCode = code
}
function launch(name, command, args, options) {
  const child = spawn(command, args, { stdio: 'inherit', detached: true, ...options })
  children.add(child)
  child.once('error', () => { children.delete(child); console.error(`${name} failed to start`); void stop(1) })
  child.once('exit', (code, signal) => {
    children.delete(child)
    if (!stopping) {
      console.error(`${name} exited: ${signal || code}`)
      void stop(code || 1)
    }
  })
  return child
}
process.on('SIGTERM', () => { void stop() })
process.on('SIGINT', () => { void stop() })

try {
  let harnessEnv = { ...process.env }
  const features = await loadFeatures()
  if (process.env.EDMORE_WIKI_ENABLED === '1' && features.some(p => p.id === 'wiki')) {
    harnessEnv = await startWikiServices({ launch, stopping: () => stopping })
  }
  if (!stopping) launch('Harness', process.execPath, ['--import', 'tsx/esm', 'start.mjs'], { env: harnessEnv })
} catch (error) {
  console.error(`Services startup failed: ${error.message}`)
  await stop(1)
}
