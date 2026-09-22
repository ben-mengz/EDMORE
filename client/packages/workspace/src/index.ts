import { randomUUID } from 'node:crypto'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-host-webserver'

export const name = 'edmore-workspace'
export const inject = []

export interface Config {
  storePath: string
  defaultProjectName: string
  defaultProjectCwd: string
}

export const Config: z<Config> = z.object({
  storePath: z.string().required(),
  defaultProjectName: z.string().default('SEM'),
  defaultProjectCwd: z.string().default(process.cwd()),
})

export interface ProjectRecord {
  id: string
  name: string
  cwd: string
  created_at: string
  updated_at: string
}

export interface ConversationRecord {
  id: string
  project_id: string
  session_id: string
  harness_session_id?: string
  title: string
  created_at: string
  updated_at: string
  last_message_preview?: string
  auto_title?: boolean
  archived?: boolean
}

interface WorkspaceStore {
  version: 1
  projects: ProjectRecord[]
  conversations: ConversationRecord[]
}

export interface EdmoreWorkspaceService {
  listProjects(): ProjectRecord[]
  listConversations(projectId?: string): ConversationRecord[]
  getProject(id: string): ProjectRecord | undefined
  getConversation(id: string): ConversationRecord | undefined
  getConversationBySessionId(sessionId: string): ConversationRecord | undefined
  upsertProject(input: { id?: string; name: string; cwd: string }): Promise<ProjectRecord>
  createConversation(input: { project_id: string; title?: string; session_id?: string; harness_session_id?: string }): Promise<ConversationRecord>
  touchConversation(input: { id?: string; session_id?: string; title?: string; last_message_preview?: string }): Promise<ConversationRecord>
  setConversationTitle(input: { id?: string; session_id?: string; title: string; auto?: boolean }): Promise<ConversationRecord>
  archiveConversation(id: string): Promise<void>
  deleteProject(id: string): Promise<void>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    edmoreWorkspace: EdmoreWorkspaceService
  }
}

function nowIso(): string {
  return new Date().toISOString()
}

export function sendJson(res: ServerResponse, statusCode: number, data: unknown): void {
  res.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(data))
}

export function sendError(res: ServerResponse, error: unknown): void {
  sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
}

export async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  if (chunks.length === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
}

export function stringField(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${name} is required`)
  return value.trim()
}

export function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

function previewTitle(value: string): string {
  const text = value.replace(/\s+/g, ' ').trim()
  return text.length > 56 ? `${text.slice(0, 53)}...` : text || 'New conversation'
}

export function putOptional(target: Record<string, unknown>, key: string, value: string | undefined): void {
  if (value !== undefined) target[key] = value
}

class EdmoreWorkspaceStore {
  private data: WorkspaceStore = { version: 1, projects: [], conversations: [] }

  constructor(private storePath: string, private defaultProjectName: string, private defaultProjectCwd: string) {}

  async ready(): Promise<void> {
    await mkdir(dirname(this.storePath), { recursive: true })
    try {
      this.data = JSON.parse(await readFile(this.storePath, 'utf8')) as WorkspaceStore
      if (this.data.version !== 1 || !Array.isArray(this.data.projects) || !Array.isArray(this.data.conversations)) {
        this.data = { version: 1, projects: [], conversations: [] }
      }
    } catch {
      this.data = { version: 1, projects: [], conversations: [] }
    }
    await this.ensureDefaultProject()
    await this.flush()
  }

  listProjects(): ProjectRecord[] {
    return [...this.data.projects].sort((a, b) => b.updated_at.localeCompare(a.updated_at))
  }

  listConversations(projectId?: string): ConversationRecord[] {
    return this.data.conversations
      .filter(item => item.archived !== true)
      .filter(item => projectId === undefined || item.project_id === projectId)
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
  }

  getProject(id: string): ProjectRecord | undefined {
    return this.data.projects.find(project => project.id === id)
  }

  getConversation(id: string): ConversationRecord | undefined {
    return this.data.conversations.find(conversation => conversation.id === id)
  }

  getConversationBySessionId(sessionId: string): ConversationRecord | undefined {
    return this.data.conversations.find(conversation => conversation.session_id === sessionId)
  }

  async upsertProject(input: { id?: string; name: string; cwd: string }): Promise<ProjectRecord> {
    const cwd = resolve(input.cwd)
    const info = await stat(cwd)
    if (!info.isDirectory()) throw new Error(`cwd is not a directory: ${cwd}`)
    const at = nowIso()
    const existing = input.id === undefined ? undefined : this.getProject(input.id)
    if (existing !== undefined) {
      existing.name = input.name
      existing.cwd = cwd
      existing.updated_at = at
      await this.flush()
      return existing
    }
    const project: ProjectRecord = {
      id: input.id ?? `project-${randomUUID()}`,
      name: input.name,
      cwd,
      created_at: at,
      updated_at: at,
    }
    this.data.projects.push(project)
    await this.flush()
    return project
  }

  async createConversation(input: { project_id: string; title?: string; session_id?: string; harness_session_id?: string }): Promise<ConversationRecord> {
    if (this.getProject(input.project_id) === undefined) throw new Error(`unknown project_id: ${input.project_id}`)
    const at = nowIso()
    const title = previewTitle(input.title ?? 'New conversation')
    const conversation: ConversationRecord = {
      id: `conversation-${randomUUID()}`,
      project_id: input.project_id,
      session_id: input.session_id ?? `NOMAD-${randomUUID().slice(0, 8)}`,
      ...input.harness_session_id === undefined ? {} : { harness_session_id: input.harness_session_id },
      title,
      auto_title: true,
      created_at: at,
      updated_at: at,
    }
    this.data.conversations.push(conversation)
    await this.touchProject(input.project_id)
    await this.flush()
    return conversation
  }

  async touchConversation(input: { id?: string; session_id?: string; title?: string; last_message_preview?: string }): Promise<ConversationRecord> {
    const conversation = input.id !== undefined
      ? this.getConversation(input.id)
      : this.data.conversations.find(item => item.session_id === input.session_id)
    if (conversation === undefined) throw new Error('conversation not found')
    const at = nowIso()
    const preview = optionalString(input.last_message_preview)
    if (optionalString(input.title) !== undefined) {
      conversation.title = previewTitle(input.title!)
      if (conversation.auto_title === undefined) conversation.auto_title = true
    }
    if (preview !== undefined) {
      conversation.last_message_preview = previewTitle(preview)
      if (conversation.title === 'New conversation') conversation.title = previewTitle(preview)
    }
    conversation.updated_at = at
    await this.touchProject(conversation.project_id, false)
    await this.flush()
    return conversation
  }

  async setConversationTitle(input: { id?: string; session_id?: string; title: string; auto?: boolean }): Promise<ConversationRecord> {
    const conversation = input.id !== undefined
      ? this.getConversation(input.id)
      : this.getConversationBySessionId(input.session_id ?? '')
    if (conversation === undefined) throw new Error('conversation not found')
    conversation.title = previewTitle(input.title)
    conversation.auto_title = input.auto !== false
    conversation.updated_at = nowIso()
    await this.touchProject(conversation.project_id, false)
    await this.flush()
    return conversation
  }

  async archiveConversation(id: string): Promise<void> {
    const conversation = this.getConversation(id)
    if (conversation === undefined) throw new Error(`conversation not found: ${id}`)
    conversation.archived = true
    conversation.updated_at = nowIso()
    await this.flush()
  }

  async deleteProject(id: string): Promise<void> {
    const projectIndex = this.data.projects.findIndex(project => project.id === id)
    if (projectIndex < 0) throw new Error(`project not found: ${id}`)
    const activeConversations = this.data.conversations.filter(
      conversation => conversation.project_id === id && conversation.archived !== true,
    )
    if (activeConversations.length > 0) {
      throw new Error(`project has ${activeConversations.length} active conversation(s); delete conversations first`)
    }
    this.data.projects.splice(projectIndex, 1)
    await this.flush()
  }

  private async ensureDefaultProject(): Promise<void> {
    if (this.data.projects.length > 0) return
    await this.upsertProject({
      id: 'project-default',
      name: this.defaultProjectName,
      cwd: this.defaultProjectCwd,
    })
  }

  private async touchProject(id: string, flush = true): Promise<void> {
    const project = this.getProject(id)
    if (project === undefined) return
    project.updated_at = nowIso()
    if (flush) await this.flush()
  }

  private async flush(): Promise<void> {
    await mkdir(dirname(this.storePath), { recursive: true })
    await writeFile(this.storePath, `${JSON.stringify(this.data, null, 2)}\n`, 'utf8')
  }
}

export async function apply(ctx: Context, config: Config): Promise<void> {
  const store = new EdmoreWorkspaceStore(config.storePath, config.defaultProjectName, config.defaultProjectCwd)
  await store.ready()
  ctx.provide('edmoreWorkspace', store)

}
