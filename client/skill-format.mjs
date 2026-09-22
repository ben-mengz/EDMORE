import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { parse, stringify } from 'yaml'

export { stringify }
export function parseSkillMarkdown(instructions) {
  if (typeof instructions !== 'string') throw new Error('SKILL.md must contain Markdown text.')
  const text = instructions.replace(/^\uFEFF/, '')
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)
  const front = match && parse(match[1])
  if (!object(front) || typeof front.name !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(front.name) || front.name.length > 64 || typeof front.description !== 'string' || !front.description.trim()) throw new Error('Invalid SKILL.md: name and description are required, with a lowercase hyphenated name of at most 64 characters.')
  if (front.metadata !== undefined && !object(front.metadata)) throw new Error('Skill metadata must be a mapping.')
  for (const key of ['disable-model-invocation', 'user-invocable']) if (front[key] !== undefined && typeof front[key] !== 'boolean') throw new Error(`${key} must be true or false.`)
  return { front, content: text.slice(match[0].length).replace(/^\r?\n/, '') }
}

export function renderSupportMarkdown(name, description, title, content, original = '') {
  const previous = original ? parseSkillMarkdown(original).front : {}
  const metadata = previous.metadata ?? {}
  const edmore = { ...metadata.edmore, authority: 'support' }
  delete edmore.workflow
  const nextMetadata = { ...metadata, display_name: title, edmore }
  delete nextMetadata.workflow
  return `---\n${stringify({ ...previous, name, description, metadata: nextMetadata })}---\n\n${content}${content.endsWith('\n') ? '' : '\n'}`
}

export function renderSkillMarkdown(name, description, title, steps, original = '') {
  const front = original.match(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/)
  let body = front ? original.slice(front[0].length) : original
  const summary = '<!-- edmore:steps:start -->\n' + steps.map((step, i) => `${i + 1}. ${step.title} (\`${step.tool}\`).`).join('\n') + '\n<!-- edmore:steps:end -->'
  if (body.includes('<!-- edmore:steps:start -->')) body = body.replace(/<!-- edmore:steps:start -->[\s\S]*?<!-- edmore:steps:end -->/, summary)
  else body += '\n\n## Steps\n' + summary
  const prefix = `# ${title}\n\nPrepare a PlanReview before execution. Read [the workflow](references/workflow.yaml) for exact step definitions. Failures must pause for user review.\n\n`
  const previous = front ? parse(front[0].replace(/^---\r?\n/, '').replace(/\r?\n---(?:\r?\n|$)$/, '')) : {}
  const metadata = previous.metadata ?? {}
  return `---\n${stringify({ ...previous, name, description, metadata: { ...metadata, display_name: title, edmore: { ...metadata.edmore, authority: 'workflow', workflow: 'references/workflow.yaml' } } })}---\n\n${original ? '' : prefix}${body}\n`
}
const hash = value => createHash('sha256').update(value).digest('hex')
const identifier = /^[a-z][a-z0-9_-]*$/
const object = value => value && typeof value === 'object' && !Array.isArray(value)
export function validateWorkflow(workflow) {
  if (!object(workflow) || workflow.schema_version !== 1 || !identifier.test(workflow.id) || typeof workflow.version !== 'string') throw new Error('Invalid EDMORE workflow header')
  if (!Array.isArray(workflow.steps) || !workflow.steps.length) throw new Error('Workflow must contain steps')
  const ids = new Set()
  for (const step of workflow.steps) {
    if (!identifier.test(step.id) || ids.has(step.id)) throw new Error('Step IDs must be unique and stable')
    ids.add(step.id)
    if (!/^agent_\w+\.\w+$/.test(step.tool) || !object(step.parameters)) throw new Error(`Invalid action in ${step.id}`)
    if (typeof step.title !== 'string' || !step.title || typeof step.purpose !== 'string') throw new Error(`Missing step description: ${step.id}`)
    if (step.on_success !== 'next' || step.on_failure !== 'pause') throw new Error(`Unsupported transition: ${step.id}`)
    if (step.confirm && !step.confirmation?.trim()) throw new Error(`Missing confirmation: ${step.id}`)
    if (!object(step.completion) || !['tool_success', 'field_equals', 'field_present'].includes(step.completion.type)) throw new Error(`Invalid completion condition: ${step.id}`)
    if (step.completion.type !== 'tool_success' && !/^[a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+)*$/.test(step.completion.field || '')) throw new Error(`Invalid result field: ${step.id}`)
    if (step.completion.type === 'field_equals' && !Object.hasOwn(step.completion, 'value')) throw new Error(`Missing expected value: ${step.id}`)
    for (const [name, binding] of Object.entries(step.parameters)) {
      if (['__proto__', 'constructor', 'prototype'].includes(name) || !object(binding) || !['fixed', 'default', 'ask', 'result', 'tool_default'].includes(binding.mode)) throw new Error(`Invalid binding: ${step.id}.${name}`)
      if (['fixed', 'default'].includes(binding.mode) && !Object.hasOwn(binding, 'value')) throw new Error(`Missing value: ${step.id}.${name}`)
      if (binding.mode === 'result' && !/^\{\{[\w.]+\}\}$/.test(binding.value || '')) throw new Error(`Invalid result reference: ${step.id}.${name}`)
    }
  }
  return workflow
}

export function completionSatisfied(condition, result) {
  if (!condition || condition.type === 'tool_success') return true
  let value = result.structuredContent
  for (const key of condition.field.split('.')) value = object(value) && Object.hasOwn(value, key) ? value[key] : undefined
  return condition.type === 'field_present' ? value !== undefined && value !== null : JSON.stringify(value) === JSON.stringify(condition.value)
}

async function optional(path) {
  try { return await readFile(path, 'utf8') } catch (error) { if (error.code === 'ENOENT') return undefined; throw error }
}

export async function loadSkillDirectory(directory) {
  const instructions = await optional(join(directory, 'SKILL.md'))
  const document = instructions?.replace(/^\uFEFF/, '').startsWith('---') ? parseSkillMarkdown(instructions) : undefined
  const metadata = document?.front.metadata
  const support = () => ({ id: document.front.name, name: metadata?.display_name || document.front.name, description: document.front.description,
    kind: 'knowledge', category: 'support', format: 'agent-skills', instructions, content: document.content, metadata, directory, steps: [], digest: hash(instructions) })
  if (metadata?.edmore?.authority && metadata.edmore.authority !== 'workflow') return support()
  const yaml = await optional(join(directory, 'references/workflow.yaml'))
  if (yaml === undefined && (metadata?.workflow === 'references/workflow.yaml' || metadata?.edmore?.workflow === 'references/workflow.yaml')) throw new Error(`${directory}: declared workflow.yaml is missing`)
  if (yaml !== undefined) {
    // A malformed new format must never fall back to an older executable definition.
    if (!instructions) throw new Error(`${directory}: SKILL.md is required`)
    const match = instructions.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)
    const front = match && parse(match[1])
    if (!front || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(front.name) || front.name.length > 64 || typeof front.description !== 'string' || !front.description.trim()) throw new Error(`${directory}: invalid Agent Skills frontmatter`)
    const workflow = validateWorkflow(parse(yaml))
    return { id: workflow.id, name: front.metadata?.display_name || front.name, description: front.description, version: workflow.version,
      kind: 'workflow', category: 'workflow', metadata, format: 'agent-skills-v1', instructions, instructionsPath: join(directory, 'SKILL.md'), directory,
      steps: workflow.steps, workflow, digest: hash(instructions + '\n' + yaml), editor_version: 1,
      agents: [...new Set(workflow.steps.map(step => step.tool.split('.')[0]))],
      required_tools: [...new Set(workflow.steps.map(step => step.tool))], ordered_tools: workflow.steps.map(step => step.tool), optional_tools: [], references: [] }
  }
  const legacy = await optional(join(directory, 'manifest.json'))
  if (legacy !== undefined) {
    const data = JSON.parse(legacy)
    return { ...data, category: data.kind === 'knowledge' ? 'support' : 'workflow', metadata, format: 'legacy', instructions: instructions || '', content: document?.content || '', instructionsPath: join(directory, 'SKILL.md'), directory, digest: hash(legacy + (instructions || '')) }
  }
  if (instructions !== undefined) {
    if (!document) throw new Error(`${directory}: invalid SKILL.md`)
    return support()
  }
  throw new Error(`${directory}: no skill definition found`)
}

export async function loadSkillRoot(root) {
  let entries
  try { entries = await readdir(root, { withFileTypes: true }) } catch (error) { if (error.code === 'ENOENT') return []; throw error }
  const rows = []
  for (const entry of entries) {
    if (entry.isDirectory() && !entry.name.startsWith('.')) rows.push(await loadSkillDirectory(join(root, entry.name)))
  }
  const unique = new Map()
  for (const row of rows.sort((a, b) => Number(a.format === 'legacy') - Number(b.format === 'legacy'))) if (!unique.has(row.id)) unique.set(row.id, row)
  return [...unique.values()]
}
