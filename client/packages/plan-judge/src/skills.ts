import { createHash } from 'node:crypto'
import { readFile, realpath, access } from 'node:fs/promises'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { parse } from 'yaml'
import { isModelInvocable, type SkillDefinition, type SkillSummary, type SkillViewOptions } from '@deepseek-ai/dsh-skill'
import { loadSkillDirectory, validateWorkflow } from '../../../skill-format.mjs'
import type { SkillContract } from './index.ts'
import { validateConfirmations } from './confirmation.ts'
import { validateRecoveryLoops } from './recovery.ts'

export interface SkillRegistryReader {
  snapshot(options: SkillViewOptions): Promise<{ complete: boolean; skills: SkillSummary[] }>
  get(name: string, options: SkillViewOptions): Promise<SkillDefinition | undefined>
}

export interface SupportingSkill {
  name: string
  provider: string
  source: string
  content: string
  resourceBase?: SkillDefinition['resourceBase']
  digest: string
}

export interface PlanSkillEvidence {
  contract_skill: SkillContract
  workflow_contracts: SkillContract[]
  supporting_skills: SupportingSkill[]
}

export function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

export function sealContract(contract: SkillContract): SkillContract {
  const { snapshot_digest: _old, ...body } = contract
  return { ...body, snapshot_digest: digest(body) }
}

export function contractIsIntact(contract: SkillContract): boolean {
  return contract.snapshot_digest === sealContract(contract).snapshot_digest
}

export function evidenceIssues(evidence: PlanSkillEvidence): string[] {
  const issues: string[] = []
  const contracts = new Map(evidence.workflow_contracts.map(contract => [contract.skill_id, contract]))
  if (contracts.size !== evidence.workflow_contracts.length) issues.push('Duplicate workflow contract IDs in plan evidence.')
  const root = evidence.contract_skill
  if (JSON.stringify(root) !== JSON.stringify(contracts.get(root.skill_id))) issues.push('Primary workflow differs from its pinned contract.')
  const visited = new Set<string>()
  const visit = (id: string, chain: string[]) => {
    if (chain.includes(id)) { issues.push(`Cyclic pinned workflow reference: ${id}`); return }
    if (visited.has(id)) return
    visited.add(id)
    const contract = contracts.get(id)
    if (!contract || contract.authority !== 'workflow' || !contractIsIntact(contract)) {
      issues.push(`Missing or changed workflow contract: ${id}`)
      return
    }
    for (const ref of contract.references) visit(ref, [...chain, id])
  }
  visit(root.skill_id, [])
  for (const id of contracts.keys()) if (!visited.has(id)) issues.push(`Workflow '${id}' is not declared by the primary workflow.`)
  for (const skill of evidence.supporting_skills) {
    const { digest: expected, ...body } = skill
    if (digest(body) !== expected) issues.push(`Supporting skill '${skill.name}' changed after loading.`)
  }
  return issues
}

function record(value: unknown): Record<string, any> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {}
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

export class PlanSkillAdapter {
  constructor(private registry: SkillRegistryReader, private view: SkillViewOptions) {}

  async catalog(): Promise<SkillSummary[]> {
    const snapshot = await this.registry.snapshot(this.view)
    if (!snapshot.complete) throw new Error('Skill discovery is incomplete. Retry before planning.')
    return snapshot.skills.filter(isModelInvocable)
  }

  async load(name: string): Promise<SkillDefinition> {
    const summary = (await this.catalog()).find(skill => skill.name === name)
    if (!summary) throw new Error(`Skill '${name}' is not available for model invocation.`)
    const skill = await this.registry.get(name, this.view)
    if (!skill || !isModelInvocable(skill) || skill.provider !== summary.provider) {
      throw new Error(`Skill '${name}' changed or became unavailable during loading.`)
    }
    return skill
  }

  async contract(name: string): Promise<SkillContract> {
    const skill = await this.load(name)
    const metadata = record(skill.metadata)
    const edmore = record(metadata.edmore)
    let authority = edmore.authority ?? (['workflow', 'compound_workflow'].includes(metadata.kind) ? 'workflow' : 'general')
    let resource = edmore.workflow ?? metadata.workflow
    if (edmore.authority === undefined && authority === 'general' && skill.path && skill.resourceBase?.kind === 'directory') {
      // Older desktop-authored bundles predate authority metadata.
      try {
        await access(resolve(skill.resourceBase.path, 'references/workflow.yaml'))
        authority = 'workflow'
        resource = 'references/workflow.yaml'
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    if (authority !== 'workflow') throw new Error(`Skill '${name}' is supporting material, not an EDMORE workflow contract.`)
    let raw: Record<string, any>
    if (resource !== undefined) {
      let workflow: Record<string, any>
      if (typeof resource === 'string') {
        if (skill.resourceBase?.kind !== 'directory') throw new Error(`Workflow resource for '${name}' requires a directory provider or an inline workflow.`)
        const base = await realpath(skill.resourceBase.path)
        const path = await realpath(resolve(base, resource))
        const rel = relative(base, path)
        if (isAbsolute(resource) || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error(`Workflow resource escapes skill '${name}'.`)
        workflow = validateWorkflow(parse(await readFile(path, 'utf8')))
      } else {
        workflow = validateWorkflow(resource)
      }
      raw = { id: workflow.id, version: workflow.version, steps: workflow.steps,
        agents: [...new Set(workflow.steps.map((step: any) => step.tool.split('.')[0]))],
        required_tools: workflow.steps.map((step: any) => step.tool),
        ordered_tools: workflow.steps.map((step: any) => step.tool), references: [] }
    } else if (skill.path && basename(skill.path) === 'SKILL.md' && skill.resourceBase?.kind === 'directory') {
      // Compatibility is tied to the registry winner, never a second directory search.
      raw = await loadSkillDirectory(dirname(skill.path))
      if (raw.kind === 'knowledge') throw new Error(`Workflow '${name}' has no executable definition.`)
    } else {
      throw new Error(`Workflow '${name}' needs a workflow resource or a legacy filesystem bundle.`)
    }
    const required = strings(raw.required_tools)
    const ordered = strings(raw.ordered_tools)
    const refs = strings(raw.references)
    if (!required.length && !ordered.length && !refs.length) throw new Error(`Workflow '${name}' contains no actions or child workflows.`)
    const optional = strings(raw.optional_tools)
    const recovery = validateRecoveryLoops(metadata.recovery_loops, [...required, ...ordered, ...optional])
    const confirmations = validateConfirmations(metadata.confirmation_steps)
    for (const gate of confirmations) {
      if ([gate.before_tool, gate.edit_tool, ...gate.source_tools].some(tool => ![...required, ...ordered, ...optional].includes(tool))) throw new Error(`Confirmation '${gate.id}' references an undeclared tool.`)
    }
    if ([...required, ...ordered, ...optional].some(tool => !/^agent_\w+\.\w+$/.test(tool))) throw new Error(`Workflow '${name}' declares an invalid tool.`)
    const steps = Array.isArray(raw.steps) ? raw.steps : undefined
    return sealContract({
      skill_id: String(raw.id ?? metadata.legacy_id ?? name), name: String(metadata.display_name ?? skill.name),
      authority: 'workflow', registry_name: name, provider: skill.provider, source: skill.source,
      version: raw.version, digest: digest({ content: skill.content, raw }), instructions: skill.content,
      agents: strings(raw.agents), required_tools: required, optional_tools: optional,
      ordered_tools: ordered, references: refs, ...(steps ? { steps } : {}),
      ...(confirmations.length ? { confirmation_steps: confirmations } : {}),
      ...(recovery.length ? { recovery_loops: recovery } : {}),
    })
  }

  async prepare(name: string, supportingNames: string[] = []): Promise<PlanSkillEvidence> {
    const catalog = await this.catalog()
    const contracts = new Map<string, SkillContract>()
    const visit = async (registryName: string, chain: string[]): Promise<SkillContract> => {
      if (chain.includes(registryName)) throw new Error(`Cyclic workflow reference: ${[...chain, registryName].join(' -> ')}`)
      const existing = contracts.get(registryName)
      if (existing) return existing
      const contract = await this.contract(registryName)
      contracts.set(registryName, contract)
      for (const ref of contract.references) {
        const child = catalog.find(item => item.name === ref || item.name === ref.replace(/_/g, '-'))
        if (!child) throw new Error(`Workflow '${registryName}' references unavailable skill '${ref}'.`)
        const loaded = await visit(child.name, [...chain, registryName])
        if (loaded.skill_id !== ref) throw new Error(`Workflow reference '${ref}' does not match '${loaded.skill_id}'.`)
      }
      return contract
    }
    const root = await visit(name, [])
    const supporting: SupportingSkill[] = []
    for (const support of new Set(supportingNames)) {
      if (contracts.has(support)) continue
      const skill = await this.load(support)
      const body = { name: skill.name, provider: skill.provider, source: skill.source, content: skill.content,
        ...(skill.resourceBase ? { resourceBase: skill.resourceBase } : {}) }
      supporting.push({ ...body, digest: digest(body) })
    }
    const ids = [...contracts.values()].map(contract => contract.skill_id)
    if (new Set(ids).size !== ids.length) throw new Error('Selected workflows declare duplicate contract IDs.')
    return { contract_skill: root, workflow_contracts: [...contracts.values()], supporting_skills: supporting }
  }
}
