import { join } from 'node:path'
import { homedir } from 'node:os'
import { readFile } from 'node:fs/promises'
import { readJson, writeJson } from '@edmore/plugin-host/storage'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { tangoConnection } from './index.mjs'

export async function readDevices() {
  const connection = tangoConnection()
  if (!connection) throw new Error('Tango is not connected')
  const client = new Client({ name: 'edmore-device-picker', version: '1.0.0' })
  const transport = new StreamableHTTPClientTransport(new URL(connection.url), {
    requestInit: { headers: connection.headers, signal: AbortSignal.timeout(10000) },
  })
  try {
    await client.connect(transport)
    const result = await client.callTool({ name: 'list_devices', arguments: {} }, undefined, { timeout: 10000 })
    if (result.isError) throw new Error('Tango inventory is unavailable')
    const value = result.structuredContent ?? JSON.parse(result.content.find(item => item.type === 'text')?.text ?? '{}')
    if (!Array.isArray(value.devices)) throw new Error('Invalid Tango inventory')
    return value.devices.map(item => {
      if (typeof item.device !== 'string' || typeof item.available !== 'boolean') throw new Error('Invalid Tango device')
      return { device: item.device, available: item.available, kind: typeof item.kind === 'string' ? item.kind : '' }
    })
  } finally { await client.close().catch(() => {}) }
}

export class ConversationDevices {
  constructor(path, inventory = readDevices, busy = () => false, serverName = 'tango') {
    this.path = path
    this.inventory = inventory
    this.busy = busy
    this.selections = new Map()
    this.saving = new Set()
    this.queue = Promise.resolve()
    this.prefix = `mcp__${serverName}__`
  }
  async load() {
    const stored = await readJson(this.path, { version: 1, selections: {} })
    if (stored.version !== 1 || !stored.selections || typeof stored.selections !== 'object') throw new Error('Invalid Tango conversation state')
    for (const [session, devices] of Object.entries(stored.selections)) {
      if (!Array.isArray(devices) || devices.some(device => typeof device !== 'string')) throw new Error('Invalid Tango selection')
      this.selections.set(session, devices)
    }
  }
  locked(session) { return this.saving.has(session) || this.busy(session) }
  async snapshot(session) {
    try {
      return { enabled: true, devices: await this.inventory(), selected: this.selections.get(session) ?? [], locked: this.locked(session) }
    } catch {
      return { enabled: true, devices: [], selected: this.selections.get(session) ?? [], locked: this.locked(session), error: 'Cannot load Tango devices. Check the connection and refresh.' }
    }
  }
  async select(session, devices) {
    if (!Array.isArray(devices) || devices.length > 256 || devices.some(device => typeof device !== 'string' || !device || device.length > 512)) throw new Error('Invalid device selection')
    if (this.locked(session)) throw new Error('Finish or cancel the current response and workflow before changing instruments')
    this.saving.add(session)
    try {
      const inventory = devices.length ? await this.inventory() : []
      if (devices.some(device => !inventory.some(item => item.device === device && item.available))) throw new Error('Device is unavailable or not authorized')
      if (this.busy(session)) throw new Error('Conversation became busy; selection was not changed')
      const operation = this.queue.catch(() => {}).then(async () => {
        if (this.busy(session)) throw new Error('Conversation became busy; selection was not changed')
        const next = new Map(this.selections)
        next.set(session, [...new Set(devices)])
        await writeJson(this.path, { version: 1, selections: Object.fromEntries(next) })
        this.selections = next
      })
      this.queue = operation
      await operation
    } finally { this.saving.delete(session) }
    return this.snapshot(session)
  }
  denial(session, name, args) {
    if (!name.startsWith(this.prefix) || name === this.prefix + 'list_devices') return
    if (this.saving.has(session)) return 'Instrument selection is being saved; retry after it completes.'
    if (typeof args?.device !== 'string' || !this.selections.get(session)?.includes(args.device)) return 'Select this instrument in the conversation sidebar before calling its Tango tools. An explicit selected device is required.'
  }
  prompt(session) {
    return `Tango instruments selected by the user for this conversation: ${JSON.stringify(this.selections.get(session) ?? [])}. Use only these targets for Tango calls, always pass the explicit device parameter. No selected instruments means no device calls. Selection is not authorization or workflow approval; all existing permissions and approvals still apply.`
  }
}

export const name = 'edmore-tango-conversations'
export const inject = ['edmoreTasks', 'edmoreConversationExtensions']
export async function apply(ctx) {
  const service = new ConversationDevices(join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'edmore/tango-conversations.json'), readDevices, session => {
    const state = ctx.get('edmoreWorkflow')?.state() ?? {}
    return ctx.edmoreTasks.isBusy(session) || ['planning_proposals', 'pending', 'active', 'paused'].some(key => (state[key] ?? []).some(item => item.session_id === session || item.plan?.session_id === session))
  }, process.env.EDMORE_TANGO_SERVER_NAME || 'tango')
  await service.load()
  ctx.effect(() => ctx.edmoreConversationExtensions.register({
    id: 'tango', title: 'Instruments',
    state: session => service.snapshot(session),
    update: (session, input) => service.select(session, input.devices),
    prompt: session => service.prompt(session),
    denial: (session, tool, args) => service.denial(session, tool, args),
    asset: async file => ['panel.js', 'panel.css'].includes(file) ? {
      body: await readFile(new URL(`../static/${file}`, import.meta.url), 'utf8'),
      type: file.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8',
    } : undefined,
  }))
}
