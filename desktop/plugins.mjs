import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const exec = promisify(execFile)
const packagePattern = /^((?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*)(?:@([a-zA-Z0-9._~^+-]+))?$/
export function packageName(spec) {
  const match = typeof spec === 'string' && packagePattern.exec(spec)
  if (!match) throw new Error('invalidPackage')
  return match[1]
}
export function pluginPatch(state) {
  return [
    ...(state.added.length ? [{ insert: state.added.map(row => ({ id: row.id, name: row.name, config: row.config })) }] : []),
    ...Object.entries(state.disabled).map(([id, disabled]) => ({ id, disabled })),
  ]
}

export class PluginManager {
  constructor(config, dataDir, run = exec) {
    this.config = config
    this.run = run
    const key = createHash('sha256').update(JSON.stringify([config.root, config.profile, process.env.DSH_HOME ?? ''])).digest('hex').slice(0, 20)
    this.directory = join(dataDir, 'plugins', key)
    this.path = join(this.directory, 'desktop.patch.yml')
    this.statePath = join(this.directory, 'plugins.json')
  }

  async read() {
    try { return { packages: [], ...JSON.parse(await readFile(this.statePath, 'utf8')) } }
    catch (error) { if (error.code === 'ENOENT') return { added: [], disabled: {}, packages: [] }; throw error }
  }

  async save(state) {
    await mkdir(this.directory, { recursive: true })
    // The patch is derived on launch as well, so interrupted metadata writes cannot activate a partial edit.
    const temporary = `${this.statePath}.${randomUUID()}.tmp`
    await writeFile(temporary, JSON.stringify(state, null, 2))
    await rename(temporary, this.statePath)
    await this.writePatch(state)
  }

  async writePatch(state = undefined) {
    await mkdir(this.directory, { recursive: true })
    const temporary = `${this.path}.${randomUUID()}.tmp`
    await writeFile(temporary, JSON.stringify(pluginPatch(state ?? await this.read()), null, 2))
    await rename(temporary, this.path)
    return this.path
  }

  async command(operation, spec = '') {
    const env = { ...process.env, PATH: [dirname(this.config.node), join(this.config.root, 'node_modules/.bin'), process.env.PATH ?? ''].join(process.platform === 'win32' ? ';' : ':') }
    delete env.NODE_OPTIONS
    delete env.ELECTRON_RUN_AS_NODE
    const result = await this.run(this.config.node, ['--import', 'tsx/esm',
      fileURLToPath(new URL('./profile-inspector.mjs', import.meta.url)), this.config.root, this.config.profile, operation, spec],
    { cwd: this.config.root, env, windowsHide: true, timeout: operation === 'list' ? 15000 : 120000, maxBuffer: 1024 * 1024 })
    return result.stdout
  }

  async list() {
    const state = await this.read()
    const inventory = JSON.parse(await this.command('list'))
    return { rows: [...inventory.rows.map(row => ({ ...row, source: 'base',
      overridden: Object.hasOwn(state.disabled, row.id),
      disabled: Object.hasOwn(state.disabled, row.id) ? state.disabled[row.id] : row.disabled })),
    ...state.added.map(row => ({ id: row.id, name: row.name, source: 'desktop', removable: true,
      disabled: state.disabled[row.id] ?? false })),
    ...state.packages.filter(name => !state.added.some(row => row.name === name)).map(name => ({
      id: `package:${name}`, name, source: 'desktop', removable: true, kind: 'package', disabled: false,
    }))], bundles: inventory.bundles }
  }

  async toggle(id, enabled) {
    if (this.busy) throw new Error('pluginBusy')
    this.busy = true
    try {
      const inventory = await this.list()
      if (!inventory.rows.some(row => row.id === id && !row.parent && row.kind !== 'package')) throw new Error('Unknown plugin id')
      const state = await this.read()
      if (enabled === null) delete state.disabled[id]
      else if (typeof enabled === 'boolean') state.disabled[id] = !enabled
      else throw new Error('Invalid enabled value')
      await this.save(state)
      return await this.list()
    } finally { this.busy = false }
  }

  async install(spec, config) {
    const name = packageName(spec)
    if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('invalidConfig')
    if (this.busy) throw new Error('pluginBusy')
    this.busy = true
    try {
      const before = JSON.parse(await this.command('list'))
      await this.command('add', spec)
      const inventory = JSON.parse(await this.command('list'))
      const state = await this.read()
      if (!state.packages.includes(name) && !before.bundles.includes(name) && !before.rows.some(row => row.name === name)) state.packages.push(name)
      if (!inventory.bundles.includes(name) && !inventory.rows.some(row => row.name === name) && !state.added.some(row => row.name === name)) {
        state.added.push({ id: `desktop-${randomUUID()}`, name, config })
      }
      await this.save(state)
      return { ...await this.list(), notice: inventory.bundles.includes(name) && Object.keys(config).length ? 'bundleOwnConfig' : 'installed' }
    } finally { this.busy = false }
  }

  async remove(id) {
    if (this.busy) throw new Error('pluginBusy')
    this.busy = true
    try {
      const state = await this.read()
      const row = state.added.find(row => row.id === id)
      const name = row?.name ?? (typeof id === 'string' && id.startsWith('package:') ? id.slice(8) : '')
      if (!state.packages.includes(name)) throw new Error('Only desktop-added plugins can be removed here')
      await this.command('remove', packageName(name))
      state.added = state.added.filter(item => item.name !== name)
      state.packages = state.packages.filter(item => item !== name)
      delete state.disabled[id]
      const remaining = JSON.parse(await this.command('list'))
      const ids = new Set([...remaining.rows, ...state.added].map(item => item.id))
      for (const key of Object.keys(state.disabled)) if (!ids.has(key)) delete state.disabled[key]
      await this.save(state)
      return await this.list()
    } finally { this.busy = false }
  }
}
