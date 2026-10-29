import { cp, lstat, mkdir, readdir, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { SkillManager } from '../../../../desktop/skills.mjs'
import { readJson, writeJson, pluginCatalog } from './store.mjs'
import { normalizeMcp, mcpPatch } from '../../../../desktop/mcp-settings.mjs'

const initial = () => ({ revision: 0, plugins: { ...Object.fromEntries(pluginCatalog.map(p => [p.id, p.defaultEnabled])), 'edmore-jev-decisions': false }, mcp: [], jevKey: '' })
const bad = message => Object.assign(new Error(message), { status: 400 })
export class AdminSettings {
  constructor(root, home) {
    this.root = root
    this.home = join(home, 'auth', 'admin')
    this.path = join(this.home, 'settings.json')
    this.skills = new SkillManager({ root }, this.home)
    this.pending = Promise.resolve()
  }
  async read() { const state=await readJson(this.path,initial());return {...state,plugins:{...initial().plugins,...state.plugins}} }
  change(action) {
    const result = this.pending.then(action)
    this.pending = result.catch(() => {})
    return result
  }
  async commit(state, actor, action) {
    const previous = await this.read()
    await writeJson(join(this.home, 'history', `${previous.revision}.json`), previous)
    const next = { ...state, revision: previous.revision + 1, updatedBy: actor, updatedAt: new Date().toISOString(), action }
    await writeJson(this.path, next)
    return this.publicState(next)
  }
  publicState(state) {
    return { ...state, jevKey: undefined, jevKeyConfigured: Boolean(state.jevKey), mcp: state.mcp.map(({ headers, env, ...row }) => ({ ...row, secretConfigured: Boolean(Object.keys(headers || {}).length || Object.keys(env || {}).length) })) }
  }
  async view() { return this.publicState(await this.read()) }
  async savePlugin(input, actor) {
    return this.change(async () => {
      const state = await this.read()
      if (!Object.hasOwn(state.plugins, input.id) || typeof input.enabled !== 'boolean') throw bad('Unknown configurable plugin')
      if (input.apiKey !== undefined && (typeof input.apiKey !== 'string' || input.apiKey.length > 4096)) throw bad('Invalid API key')
      if (input.id === 'edmore-jev-decisions' && input.apiKey?.trim()) state.jevKey = input.apiKey.trim()
      if (input.clearKey === true && input.id === 'edmore-jev-decisions') state.jevKey = ''
      if (input.id === 'edmore-jev-decisions' && input.enabled) {
        if (!state.jevKey) throw bad('Configure a TypeSafe API key before enabling Jev')
        if (!state.plugins['edmore-plan-judge']) throw bad('Enable Workflow Engine before enabling Jev')
      }
      state.plugins[input.id] = input.enabled
      if (!state.plugins['edmore-plan-judge'] || !state.jevKey) state.plugins['edmore-jev-decisions'] = false
      return this.commit(state, actor, 'plugin-settings')
    })
  }
  async saveMcp(input, actor) {
    return this.change(async () => {
      const state = await this.read()
      if (!/^[a-zA-Z0-9_-]{1,32}$/.test(input.id || '')) throw bad('MCP name must contain 1 to 32 letters, numbers, underscores or hyphens')
      if (input.remove === true) { state.mcp = state.mcp.filter(row => row.id !== input.id); return this.commit(state, actor, 'remove-mcp') }
      const old = state.mcp.find(row => row.id === input.id)
      const row = normalizeMcp(input, old)
      row.scope = input.scope ?? old?.scope ?? 'administrators'
      if (!['administrators', 'shared'].includes(row.scope)) throw bad('Invalid MCP scope')
      if (!old && state.mcp.length >= 20) throw bad('Maximum 20 MCP connections')
      state.mcp = [...state.mcp.filter(item => item.id !== row.id), row]
      return this.commit(state, actor, 'mcp-settings')
    })
  }
  async saveSkill(input, actor) {
    return this.change(async () => {
      const result = await this.skills.save(input)
      await this.commit(await this.read(), actor, 'skill-save')
      return result
    })
  }
  async removeSkill(id, actor) {
    return this.change(async () => {
      const { rows } = await this.skills.list()
      const row = rows.find(row => row.id === id)
      if (!row || row.source !== 'custom') throw bad('Only custom skills can be removed')
      const directory = join(this.skills.root, id.replaceAll('_', '-'))
      await this.skills.rejectSymlink(directory)
      await mkdir(join(this.home, 'removed-skills'), { recursive: true, mode: 0o700 })
      await rename(directory, join(this.home, 'removed-skills', randomUUID()))
      return this.commit(await this.read(), actor, 'skill-remove')
    })
  }
  async workerSettings(home, workspace, isAdmin, personal, personalJevKeyConfigured = false, personalMcp = []) {
    // Snapshot shared skills, so a save cannot change an in-flight workflow.
    return this.change(async () => {
      const state = await this.read()
      const skills = join(home, 'admin-skills', String(state.revision))
      await mkdir(skills, { recursive: true, mode: 0o700 })
      for (const entry of await readdir(this.skills.root).catch(e => { if (e.code === 'ENOENT') return []; throw e })) {
        await cp(join(this.skills.root, entry), join(skills, entry), { recursive: true, force: true, filter: async source => {
          if ((await lstat(source)).isSymbolicLink()) throw bad('Symbolic links in shared skills are not supported')
          return true
        } })
      }
      const plan = state.plugins['edmore-plan-judge'] && personal['edmore-plan-judge']
      const jevKeyConfigured = isAdmin ? Boolean(state.jevKey) : personalJevKeyConfigured
      const jev = plan && state.plugins['edmore-jev-decisions'] && jevKeyConfigured
      const patch = [
        { id: 'skill-filesystem', config: { includeDefaultRoots: false, customSkillDirs: [join(home,'edmore','skills'), skills, join(this.root, 'skills')] } },
        { id: 'edmore-plan-judge', disabled: !plan },
        { id: 'edmore-conversation-title', disabled: !(state.plugins['edmore-conversation-title'] && personal['edmore-conversation-title']) },
        { id: 'edmore-jev-decisions', disabled: !jev },
      ]
      const managed = state.mcp.filter(row => isAdmin || row.scope === 'shared')
      // Administrator names take precedence even while disabled; a personal
      // connection must never impersonate a newly published shared connection.
      const names = new Set(managed.map(row => row.id))
      patch.push(...mcpPatch(managed, 'admin', workspace))
      patch.push(...mcpPatch(personalMcp.filter(row => !names.has(row.id)), 'personal', workspace))
      const path = join(home, 'admin.patch.json')
      await writeJson(path, patch)
      return { path, revision: state.revision, jevEnabled: jev }
    })
  }
}
