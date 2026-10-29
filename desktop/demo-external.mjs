import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { resolve } from 'node:path'

const exec = promisify(execFile)

// Only the known local simulator MCP is eligible, never an arbitrary port owner.
export async function inspectExternalDemo(clientRoot, run = exec) {
  let listeners
  try { listeners = (await run('lsof', ['-nP', '-iTCP:8010', '-sTCP:LISTEN', '-t'])).stdout.trim() }
  catch (error) { if (error.code === 1 && !error.stdout?.trim()) return null; throw error }
  const pids = [...new Set(listeners.split(/\s+/).filter(Boolean))]
  if (pids.length !== 1 || !/^\d+$/.test(pids[0])) return null
  const pid = Number(pids[0])
  const identity = (await run('ps', ['-p', String(pid), '-o', 'lstart=', '-o', 'command='])).stdout.trim()
  const root = process.env.EDMORE_DEMO_ROOT || resolve(clientRoot, '../../asyncroscopy')
  if (!identity.includes(`${root}/.venv-twin/bin/python`)
    || !/ -m asyncroscopy\.mcp\.mcp_server(?: |$)/.test(identity)
    || !/ --name AsyncroscopyDigitalTwin(?: |$)/.test(identity)
    || !/ --http-host 127\.0\.0\.1(?: |$)/.test(identity)
    || !/ --http-port 8010(?: |$)/.test(identity)) return null
  return { pid, identity }
}

export async function stopExternalDemo(clientRoot, expected, {
  inspect = inspectExternalDemo, signal = (pid => process.kill(pid, 'SIGTERM')),
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), attempts = 40,
} = {}) {
  if (!expected) throw new Error('No verified external Demo MCP selected.')
  const current = await inspect(clientRoot)
  if (!current || current.pid !== expected.pid || current.identity !== expected.identity) {
    throw new Error('Demo MCP changed since confirmation. Refresh and try again.')
  }
  signal(current.pid)
  for (let attempt = 0; attempt < attempts; attempt++) {
    await sleep(250)
    const remaining = await inspect(clientRoot)
    if (!remaining) return
    if (remaining.pid !== current.pid || remaining.identity !== current.identity) {
      throw new Error('Another Demo MCP started. It was not stopped.')
    }
  }
  throw new Error('Demo MCP has not stopped yet. No force kill was sent.')
}
