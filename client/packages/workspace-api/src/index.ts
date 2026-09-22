import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { sendJson, sendError, readJsonBody, stringField, optionalString, putOptional } from '@deepseek-ai/dsh-edmore-workspace'
export const name = 'edmore-workspace-api'
export const inject = ['webServer', 'edmoreWorkspace']
declare module '@deepseek-ai/cordis' { interface Context { edmoreWorkspaceApi: boolean } }
export function apply(ctx: Context) {
  const store = ctx.edmoreWorkspace
  ctx.provide('edmoreWorkspaceApi', true)
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/api/edmore-workspace',
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      try {
        const url = new URL(req.url ?? '/', 'http://x')
        if (req.method === 'GET' && url.pathname === '/api/edmore-workspace/projects') {
          sendJson(res, 200, { ok: true, projects: store.listProjects() })
          return
        }
        if (req.method === 'POST' && url.pathname === '/api/edmore-workspace/projects') {
          const body = await readJsonBody(req)
          const input = {
            name: stringField(body.name, 'name'),
            cwd: stringField(body.cwd, 'cwd'),
          } as Record<string, unknown>
          putOptional(input, 'id', optionalString(body.id))
          const project = await store.upsertProject(input as { id?: string; name: string; cwd: string })
          sendJson(res, 200, { ok: true, project })
          return
        }
        if (req.method === 'DELETE' && url.pathname === '/api/edmore-workspace/projects') {
          const id = stringField(url.searchParams.get('id'), 'id')
          await store.deleteProject(id)
          sendJson(res, 200, { ok: true })
          return
        }
        if (req.method === 'GET' && url.pathname === '/api/edmore-workspace/conversations') {
          const projectId = optionalString(url.searchParams.get('project_id'))
          sendJson(res, 200, { ok: true, conversations: store.listConversations(projectId) })
          return
        }
        if (req.method === 'POST' && url.pathname === '/api/edmore-workspace/conversations') {
          const body = await readJsonBody(req)
          const input = {
            project_id: stringField(body.project_id, 'project_id'),
          } as { project_id: string; title?: string; session_id?: string; harness_session_id?: string }
          putOptional(input, 'title', optionalString(body.title))
          putOptional(input, 'session_id', optionalString(body.session_id))
          putOptional(input, 'harness_session_id', optionalString(body.harness_session_id))
          const conversation = await store.createConversation(input)
          sendJson(res, 200, { ok: true, conversation })
          return
        }
        if (req.method === 'POST' && url.pathname === '/api/edmore-workspace/conversations/touch') {
          const body = await readJsonBody(req)
          const input = {} as { id?: string; session_id?: string; title?: string; last_message_preview?: string }
          putOptional(input, 'id', optionalString(body.id ?? body.conversation_id))
          putOptional(input, 'session_id', optionalString(body.session_id))
          putOptional(input, 'title', optionalString(body.title))
          putOptional(input, 'last_message_preview', optionalString(body.last_message_preview))
          const conversation = await store.touchConversation(input)
          sendJson(res, 200, { ok: true, conversation })
          return
        }
        if (req.method === 'DELETE' && url.pathname === '/api/edmore-workspace/conversations') {
          const id = stringField(url.searchParams.get('id'), 'id')
          await store.archiveConversation(id)
          sendJson(res, 200, { ok: true })
          return
        }
        res.writeHead(404)
        res.end()
      } catch (error) {
        sendError(res, error)
      }
    },
  }), 'edmore.workspace-api')
}
