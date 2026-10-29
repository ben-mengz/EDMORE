import { mkdir, readdir, readFile, rename, writeFile, lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'

const safeId = /^[a-z][a-z0-9_]{2,79}$/
const supportId = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const toolId = /^agent_[a-zA-Z0-9_]+\.[a-zA-Z0-9_]+$/
export class SkillManager {
  constructor(config, home = process.env.DSH_HOME || join(homedir(), '.dsh')) {
    this.config = config
    this.root = join(home, 'edmore', 'skills')
  }
  async list() {
    const rows = [], warnings = []
    const { loadSkillRoot } = await import(pathToFileURL(join(this.config.root, 'skill-format.mjs')).href)
    for (const [root, source] of [[join(this.config.root, 'skills'), 'builtin'], [this.root, 'custom']]) {
      for (const skill of await loadSkillRoot(root)) rows.push({ ...skill, source })
    }
    return { rows, warnings }
  }
  async tools() {
    const get = async path => {
      const response = await fetch(`${this.config.baseUrl}${path}`, { signal: AbortSignal.timeout(6000) })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return response.json()
    }
    const status = await get('/api/edmore/nionswift/status')
    if (!status.ok) throw new Error(status.message || 'MCP unavailable')
    const tools = []
    for (const agent of status.agents) {
      const listing = await get(`/api/edmore/nionswift/tools?agent=${encodeURIComponent(agent)}`)
      for (const tool of listing.tools || []) tools.push({ ...tool, id: `${agent}.${tool.name}`, agent })
    }
    return tools
  }
  async save(value) {
    const category = value?.category ?? 'workflow'
    if (!['workflow', 'support'].includes(category)) throw new Error('Choose Workflow or Support.')
    if (category === 'workflow' && (!value || !safeId.test(value.id) || value.id.length > 64 || !value.id.startsWith('custom_'))) throw new Error('Custom skill ID must start with custom_, contain lowercase letters, digits or underscores, and be at most 64 characters.')
    if (category === 'support' && (typeof value.id !== 'string' || !supportId.test(value.id) || value.id.length > 64)) throw new Error('Support skill ID must use lowercase letters, digits and hyphens, with at most 64 characters.')
    if (typeof value.name !== 'string' || !value.name.trim() || value.name.length > 160) throw new Error('A skill name is required (maximum 160 characters).')
    if (typeof value.description !== 'string' || !value.description.trim() || value.description.length > 4000) throw new Error('A description is required (maximum 4000 characters).')
    const { rows } = await this.list()
    const matches = rows.filter(row => row.id.replaceAll('_', '-') === value.id.replaceAll('_', '-'))
    if (matches.some(row => row.source === 'builtin')) throw new Error('Built-in skills are read-only.')
    if (matches.some(row => row.category !== category)) throw new Error('This ID belongs to a different skill category. Use a new ID.')
    if (category === 'support') return this.saveSupport(value)
    if (!Array.isArray(value.steps) || !value.steps.length || value.steps.length > 100) throw new Error('A workflow needs 1 to 100 steps.')
    const steps = value.steps.map((step, index) => {
      if (!toolId.test(step.tool)) throw new Error(`Step ${index + 1}: select an MCP tool.`)
      if (!step.parameters || typeof step.parameters !== 'object' || Array.isArray(step.parameters)) throw new Error(`Step ${index + 1}: invalid parameters.`)
      const parameters = {}
      for (const [key, binding] of Object.entries(step.parameters)) {
        if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key) || ['__proto__', 'constructor', 'prototype'].includes(key) || !['fixed', 'default', 'ask', 'result', 'tool_default'].includes(binding?.mode)) throw new Error(`Step ${index + 1}: invalid parameter binding.`)
        if (['fixed', 'default'].includes(binding.mode) && (binding.value === undefined || (typeof binding.value === 'number' && !Number.isFinite(binding.value)))) throw new Error(`Step ${index + 1}: enter a value for ${key}.`)
        if (binding.mode === 'result' && !/^\{\{[a-zA-Z0-9_.]+\}\}$/.test(binding.value)) throw new Error(`Step ${index + 1}: result reference must use {{tool.field}}.`)
        if (binding.mode === 'result' && !value.steps.slice(0, index).some(previous => previous.tool.split('.')[1] === binding.value.slice(2, -2).split('.')[0])) throw new Error(`Step ${index + 1}: result must reference an earlier tool.`)
        parameters[key] = binding
      }
      if (step.confirm && (typeof step.confirmation !== 'string' || !step.confirmation.trim())) throw new Error(`Step ${index + 1}: enter the confirmation question.`)
      const success = step.on_success || 'next'
      return { id: step.id || `step-${randomUUID()}`, title: step.title || step.tool, purpose: step.purpose || '', tool: step.tool, parameters, confirm: Boolean(step.confirm || step.confirmation_required), confirmation_required: Boolean(step.confirmation_required), confirmation: step.confirm || step.confirmation_required ? step.confirmation.trim() : '', expected_output: String(step.expected_output || '').slice(0, 4000), completion: step.completion || { type: 'tool_success' }, failure_guidance: step.failure_guidance || '', on_success: index === value.steps.length - 1 && success === 'next' ? 'complete' : success, on_failure: step.on_failure || 'pause', ...(step.on_error === undefined ? {} : { on_error: step.on_error }), ...(step.max_visits === undefined || step.max_visits === '' ? {} : { max_visits: Number(step.max_visits) }) }
    })
    if (JSON.stringify(steps).length > 200000) throw new Error('Skill is too large.')
    const manifest = { id: value.id, name: value.name.trim(), description: value.description.trim(), inherited_instructions: String(value.inherited_instructions || '').slice(0, 50000), version: '1.0.0', kind: 'workflow', editor_version: 1,
      agents: [...new Set(steps.map(step => step.tool.split('.')[0]))], required_tools: [...new Set(steps.map(step => step.tool))], ordered_tools: steps.map(step => step.tool), references: [], steps }
    const { validateWorkflow, stringify, loadSkillDirectory, renderSkillMarkdown } = await import(pathToFileURL(join(this.config.root, 'skill-format.mjs')).href)
    const workflow = validateWorkflow({ schema_version: 1, id: value.id, version: value.version || '1.0.0', steps })
    const markdown = renderSkillMarkdown(value.id.replaceAll('_', '-'), manifest.description, manifest.name, steps, value.instructions || value.inherited_instructions || '')
    const target = await this.prepareTarget(value.id)
    await this.rejectSymlink(join(target, 'references'))
    await mkdir(join(target, 'references'), { recursive: true })
    // Each file is atomically replaced; planning reads the structured workflow.
    for (const [name, content] of [['SKILL.md', markdown], ['references/workflow.yaml', stringify(workflow)]]) {
      const temporary = join(target, `.${randomUUID()}`)
      await writeFile(temporary, content, { mode: 0o600 })
      await rename(temporary, join(target, name))
    }
    return { ...await loadSkillDirectory(target), source: 'custom' }
  }

  async parseSupport(value) {
    if (typeof value?.instructions !== 'string' || value.instructions.length > 200000) throw new Error('SKILL.md must be text of at most 200,000 characters.')
    const { parseSkillMarkdown } = await import(pathToFileURL(join(this.config.root, 'skill-format.mjs')).href)
    const { front, content } = parseSkillMarkdown(value.instructions)
    return { id: front.name, name: front.metadata?.display_name || front.name, description: front.description,
      category: 'support', source: 'custom', instructions: value.instructions, content, steps: [] }
  }

  async saveSupport(value) {
    if (typeof value.content !== 'string' || !value.content.trim() || value.content.length > 200000) throw new Error('Support instructions are required (maximum 200,000 characters).')
    if (value.description.length > 1024) throw new Error('Support descriptions must be at most 1,024 characters.')
    if (value.instructions !== undefined && (typeof value.instructions !== 'string' || value.instructions.length > 200000)) throw new Error('Original SKILL.md is too large.')
    const { renderSupportMarkdown, loadSkillDirectory } = await import(pathToFileURL(join(this.config.root, 'skill-format.mjs')).href)
    const content = renderSupportMarkdown(value.id, value.description.trim(), value.name.trim(), value.content, value.instructions || '')
    const target = await this.prepareTarget(value.id)
    const temporary = join(target, `.${randomUUID()}`)
    await writeFile(temporary, content, { mode: 0o600 })
    await rename(temporary, join(target, 'SKILL.md'))
    return { ...await loadSkillDirectory(target), source: 'custom' }
  }

  async rejectSymlink(path) {
    try { if ((await lstat(path)).isSymbolicLink()) throw new Error('Symbolic link skill directories are not supported.') }
    catch (error) { if (error.code !== 'ENOENT') throw error }
  }

  async prepareTarget(id) {
    await this.rejectSymlink(this.root)
    await mkdir(this.root, { recursive: true })
    const target = join(this.root, id.replaceAll('_', '-'))
    await this.rejectSymlink(join(this.root, id))
    await this.rejectSymlink(target)
    await mkdir(target, { recursive: true })
    return target
  }
}
