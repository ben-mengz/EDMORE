import type { Context } from '@deepseek-ai/cordis'
import { CapabilityUnavailableError } from '@deepseek-ai/dsh-edmore-contracts'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import { compactProfile, stringField, withOptionalSession, type AgentRoleConfigInput, type LlmProviderInput } from '@deepseek-ai/dsh-edmore-runtime/services'
import { readJsonBody, sendJson, sendError, eventQuery, queryUiEvents, projectUiEvents, uiEventMatches } from './views.ts'
export const name = 'edmore-backend'
export const inject = ['webServer', 'tools', 'skills', 'edmoreTasks', 'edmoreEvents', 'edmoreActions', 'edmoreCapabilities', 'edmoreAgentLoop', 'edmoreNionSwift', 'edmoreLlmProviders', 'edmoreAgentRoles', 'edmoreSkills', 'edmoreToolBridge']
export async function apply(ctx: Context): Promise<void> {
  ctx.provide('edmoreClientApi', true)
  const hub = ctx.edmoreEvents
  const actions = ctx.edmoreActions
  const nionSwift = ctx.edmoreNionSwift
  const llmProviders = ctx.edmoreLlmProviders
  const agentRoles = ctx.edmoreAgentRoles
  const skillContext = ctx.edmoreSkills
  const agentLoop = ctx.edmoreAgentLoop
  const requireWorkflow = () => {
    const workflow = ctx.get('edmoreWorkflow')
    if (!workflow) throw new CapabilityUnavailableError('edmore-plan-judge', 'Workflow capability is unavailable')
    return workflow
  }
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/api/edmore',
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      try {
        const url = new URL(req.url ?? '/', 'http://x')
        if (url.pathname === '/api/edmore/extensions' && req.method === 'GET') {
          sendJson(res, 200, { extensions: ctx.get('edmoreConversationExtensions')?.list() ?? [] })
          return
        }
        const extensionRoute = /^\/api\/edmore\/extensions\/([a-z][a-z0-9-]*)\/(state|panel\.js|panel\.css)$/.exec(url.pathname)
        if (extensionRoute) {
          const extension = ctx.get('edmoreConversationExtensions')?.get(extensionRoute[1]!)
          if (!extension) { sendJson(res, 404, { error: 'Extension unavailable' }); return }
          if (extensionRoute[2] === 'state' && req.method === 'GET') {
            sendJson(res, 200, await extension.state(stringField(url.searchParams.get('session_id'), 'session_id')))
          } else if (extensionRoute[2] === 'state' && req.method === 'POST') {
            const body = await readJsonBody(req)
            sendJson(res, 200, await extension.update(stringField(body.session_id, 'session_id'), body))
          } else if (req.method === 'GET') {
            const asset = await extension.asset(extensionRoute[2]!)
            if (!asset) { sendJson(res, 404, { error: 'Asset unavailable' }); return }
            res.writeHead(200, { 'content-type': asset.type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
            res.end(asset.body)
          } else sendJson(res, 405, { error: 'Unsupported method' })
          return
        }
        if (req.method === 'GET' && url.pathname === '/api/edmore/capabilities') {
          sendJson(res, 200, { capabilities: ctx.edmoreCapabilities.list() })
          return
        }
        if (req.method === 'GET' && url.pathname === '/api/edmore/health') {
          sendJson(res, 200, { ok: true, application: 'edmore-client', runtime: 'deepseek-harness-cordis', nionswift: await nionSwift.status() })
          return
        }
        if (req.method === 'GET' && url.pathname === '/api/edmore/state') {
          sendJson(res, 200, { ok: true, workflow: ctx.get('edmoreWorkflow')?.state() ?? {}, nionswift: await nionSwift.status(), llm: await llmProviders.list() })
          return
        }
        if (req.method === 'GET' && url.pathname === '/api/edmore/ui/state') {
          const query = eventQuery(req)
          sendJson(res, 200, {
            ok: true,
            session_id: query.session_id,
            runtime: 'deepseek-harness-cordis',
            workflow: ctx.get('edmoreWorkflow')?.state() ?? {},
            session_state: query.session_id ? ctx.get('edmoreSessionState')?.state(query.session_id) : undefined,
            nionswift: await nionSwift.status(),
            llm: await llmProviders.list(),
            events: queryUiEvents(hub, query),
          })
          return
        }
        if (req.method === 'GET' && url.pathname === '/api/edmore/harness/tools') {
          const tools = ctx.tools.schemas()
            .filter(tool => tool.name.startsWith('mcp__') || (url.searchParams.get('include') === 'wiki' && tool.name.startsWith('weknora_')))
            .map(tool => ({ name: tool.name, description: tool.description, parameters: tool.parameters }))
          sendJson(res, 200, { ok: true, tools })
          return
        }
        if (req.method === 'GET' && url.pathname === '/api/edmore/skills') {
          const name = url.searchParams.get('name')
          if (name) {
            const skill = await ctx.skills.get(name, { cwd: process.cwd() })
            sendJson(res, 200, { ok: true, skill })
          } else {
            sendJson(res, 200, { ok: true, ...(await skillContext.catalog()) })
          }
          return
        }
        if (req.method === 'GET' && url.pathname === '/api/edmore/llm/providers') {
          sendJson(res, 200, { ok: true, ...(await llmProviders.list()) })
          return
        }
        if (req.method === 'GET' && url.pathname === '/api/edmore/agent-roles') {
          sendJson(res, 200, { ok: true, ...(await agentRoles.list()) })
          return
        }
        if (url.pathname === '/api/edmore/conversation-model' && req.method === 'GET') {
          sendJson(res, 200, await agentRoles.conversationModel(stringField(url.searchParams.get('session_id'), 'session_id')))
          return
        }
        if (url.pathname === '/api/edmore/conversation-model' && req.method === 'POST') {
          const body = await readJsonBody(req)
          sendJson(res, 200, await agentRoles.setConversationModel(stringField(body.session_id, 'session_id'),
            body.provider == null ? undefined : stringField(body.provider, 'provider'),
            body.provider == null ? undefined : stringField(body.model, 'model')))
          return
        }
        if (req.method === 'POST' && url.pathname === '/api/edmore/agent-roles') {
          sendJson(res, 200, { ok: true, ...(await agentRoles.upsert(await readJsonBody(req) as AgentRoleConfigInput)) })
          return
        }
        if (req.method === 'POST' && url.pathname === '/api/edmore/llm/providers') {
          const profile = await llmProviders.upsert(await readJsonBody(req) as LlmProviderInput)
          sendJson(res, 200, { ok: true, profile: compactProfile(profile) })
          return
        }
        if (req.method === 'DELETE' && url.pathname === '/api/edmore/llm/providers') {
          const id = url.searchParams.get('id')
          if (!id) throw new Error('id is required')
          await llmProviders.delete(id)
          sendJson(res, 200, { ok: true, ...(await llmProviders.list()) })
          return
        }
        if (req.method === 'POST' && url.pathname === '/api/edmore/llm/active') {
          const body = await readJsonBody(req)
          await llmProviders.select(stringField(body.provider ?? body.id, 'provider'))
          sendJson(res, 200, { ok: true, ...(await llmProviders.list()) })
          return
        }
        if (req.method === 'GET' && url.pathname === '/api/edmore/events') {
          sendJson(res, 200, { events: hub.query(eventQuery(req)) })
          return
        }
        if (req.method === 'GET' && url.pathname === '/api/edmore/events/stream') {
          const query = eventQuery(req)
          res.writeHead(200, {
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-cache',
            connection: 'keep-alive',
          })
          for (const event of hub.query(query)) {
            res.write(`id: ${event.cursor}\ndata: ${JSON.stringify(event)}\n\n`)
          }
          const dispose = hub.subscribe((event) => {
            if (!hub.matches(event, query)) return
            res.write(`id: ${event.cursor}\ndata: ${JSON.stringify(event)}\n\n`)
          })
          req.on('close', dispose)
          return
        }
        if (req.method === 'GET' && url.pathname === '/api/edmore/ui/stream') {
          const query = eventQuery(req)
          res.writeHead(200, {
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-cache',
            connection: 'keep-alive',
          })
          for (const event of queryUiEvents(hub, query)) {
            res.write(`id: ${event.cursor}\ndata: ${JSON.stringify(event)}\n\n`)
          }
          const dispose = hub.subscribe((raw) => {
            for (const event of projectUiEvents(raw)) {
              if (!uiEventMatches(event, query)) continue
              res.write(`id: ${event.cursor}\ndata: ${JSON.stringify(event)}\n\n`)
            }
          })
          req.on('close', dispose)
          return
        }
        if (req.method === 'POST' && url.pathname === '/api/edmore/events') {
          sendJson(res, 200, { ok: true, event: await hub.append(await readJsonBody(req) as never) })
          return
        }
        if (req.method === 'GET' && url.pathname === '/api/edmore/nionswift/status') {
          sendJson(res, 200, await nionSwift.status())
          return
        }
        if (req.method === 'GET' && url.pathname === '/api/edmore/nionswift/tools') {
          const agent = url.searchParams.get('agent')
          if (!agent) throw new Error('missing agent')
          sendJson(res, 200, await nionSwift.listTools(agent))
          return
        }
        if (req.method === 'GET' && url.pathname === '/api/edmore/nionswift/resources') {
          const agent = url.searchParams.get('agent')
          if (!agent) throw new Error('missing agent')
          sendJson(res, 200, await nionSwift.listResources(agent))
          return
        }
        if (req.method === 'POST' && url.pathname === '/api/edmore/actions/trigger') {
          const body = await readJsonBody(req)
          const prompt = typeof body.prompt === 'string' ? body.prompt : ''
          const sessionId = typeof body.session_id === 'string' ? body.session_id : undefined
          const actionId = typeof body.action_id === 'string' ? body.action_id : randomUUID()
          const { prompt: _prompt, session_id: _sessionId, action_id: _actionId, ...payload } = body
          void _prompt
          void _sessionId
          void _actionId
          const result = await actions.run(actionId, 'trigger', sessionId, async () => ({ event: await hub.append(withOptionalSession({ type: 'edmore.trigger.requested', source: 'edmore-client-api', scope: 'workflow', payload: { ...payload, prompt } }, sessionId)) }), body)
          sendJson(res, 200, { ok: true, action_id: result.action_id, replayed: result.replayed, ...result.result })
          return
        }
        if (req.method === 'POST' && url.pathname === '/api/edmore/actions/cancel-workflow') {
          const body = await readJsonBody(req)
          const sessionId = stringField(body.session_id, 'session_id')
          // Cancellation is repeatable and must run before receipt/LLM queues.
          // An old failed or indeterminate action receipt cannot veto it.
          const cancellation = requireWorkflow().cancelSession(sessionId)
          const cancelled = ctx.edmoreTasks.cancel(sessionId)
          const state = await cancellation
          sendJson(res, 200, { ok: true, cancelled, ...state })
          return
        }
        if (req.method === 'POST' && url.pathname === '/api/edmore/actions/cancel') {
          const body = await readJsonBody(req)
          const sessionId = stringField(body.session_id, 'session_id')
          const actionId = typeof body.action_id === 'string' ? body.action_id : randomUUID()
          const result = await actions.run(actionId, 'cancel', sessionId, async () => {
            const cancelled = ctx.edmoreTasks.cancel(sessionId)
            await hub.append({ type: 'edmore.custom.task.cancelled', source: 'edmore-client-api', scope: 'workflow', session_id: sessionId, payload: { cancelled, hardware_stop_verified: false } })
            return { cancelled, hardware_stop_verified: false }
          }, body)
          sendJson(res, 200, { ok: true, ...result })
          return
        }
        if (req.method === 'POST' && url.pathname === '/api/edmore/actions/edit-plan') {
          const body = await readJsonBody(req)
          if (typeof body.workflow_id !== 'string' || typeof body.session_id !== 'string') throw new Error('workflow_id and session_id are required')
          const workflow = requireWorkflow()
          if (!workflow.editTemporaryPlan) throw new Error('Plan editing is unavailable')
          const actionId = typeof body.action_id === 'string' ? body.action_id : randomUUID()
          const result = await actions.run(actionId, 'edit-plan', body.session_id, async () => ({
            plan: await workflow.editTemporaryPlan!(body.workflow_id as string, body.session_id as string, body.draft),
          }), body)
          sendJson(res, 200, { ok: true, ...result.result })
          return
        }
        if (req.method === 'POST' && url.pathname === '/api/edmore/actions/approve') {
          const body = await readJsonBody(req)
          if (typeof body.workflow_id !== 'string') throw new Error('workflow_id is required')
          const bodySessionId = typeof body.session_id === 'string' ? body.session_id : undefined
          const actionId = typeof body.action_id === 'string' ? body.action_id : randomUUID()
          const result = await actions.run(actionId, 'approve', bodySessionId, async () => {
            const route = await requireWorkflow().approve(body.workflow_id as string, bodySessionId)
            if (route.action === 'execute' && route.executionPrompt !== undefined) {
              void agentLoop.runWorkflow({
                event_id: actionId,
                cursor: 0,
                timestamp: new Date().toISOString(),
                source: 'edmore-client-api',
                type: 'edmore.approval.granted',
                scope: 'workflow',
                ...bodySessionId === undefined ? {} : { session_id: bodySessionId },
                workflow_id: body.workflow_id as string,
                payload: {},
              }, route.executionPrompt, route.workflowId, route.role).catch(error => ctx.logger.warn(error instanceof Error ? error : new Error(String(error))))
            }
            return { route: { action: route.action, workflow_id: route.workflowId, role: route.role, message: route.message } }
          }, body)
          sendJson(res, 200, { ok: true, action_id: result.action_id, replayed: result.replayed, ...result.result })
          return
        }
        if (req.method === 'POST' && url.pathname === '/api/edmore/actions/resume') {
          const body = await readJsonBody(req)
          const bodySessionId = typeof body.session_id === 'string' ? body.session_id : undefined
          const workflowId = typeof body.workflow_id === 'string' ? body.workflow_id : undefined
          const prompt = typeof body.prompt === 'string' ? body.prompt : 'confirm'
          const actionId = typeof body.action_id === 'string' ? body.action_id : randomUUID()
          const result = await actions.run(actionId, 'resume', bodySessionId, async () => {
            const route = await requireWorkflow().resume(workflowId, bodySessionId, prompt, undefined, body.confirmation_context)
            if (route.action === 'execute' && route.executionPrompt !== undefined) {
              void agentLoop.runWorkflow({
                event_id: actionId,
                cursor: 0,
                timestamp: new Date().toISOString(),
                source: 'edmore-client-api',
                type: 'edmore.workflow.resumed',
                scope: 'workflow',
                ...bodySessionId === undefined ? {} : { session_id: bodySessionId },
                ...route.workflowId === undefined ? {} : { workflow_id: route.workflowId },
                payload: { prompt },
              }, route.executionPrompt, route.workflowId, route.role).catch(error => ctx.logger.warn(error instanceof Error ? error : new Error(String(error))))
            }
            return { route: { action: route.action, workflow_id: route.workflowId, role: route.role, message: route.message } }
          }, body)
          sendJson(res, 200, { ok: true, action_id: result.action_id, replayed: result.replayed, ...result.result })
          return
        }
        if (req.method === 'POST' && url.pathname === '/api/edmore/actions/cancel-paused') {
          const body = await readJsonBody(req)
          if (typeof body.workflow_id !== 'string' || typeof body.session_id !== 'string') throw new Error('workflow_id and session_id are required')
          const result = await actions.run(typeof body.action_id === 'string' ? body.action_id : randomUUID(), 'cancel-paused', body.session_id, async () => {
            await requireWorkflow().cancelPaused(body.workflow_id as string, body.session_id as string, body.hardware_stop_verified === true)
            return { cancelled: true }
          }, body)
          sendJson(res, 200, { ok: true, ...result.result })
          return
        }
        if (req.method === 'POST' && url.pathname === '/api/edmore/actions/reject') {
          const body = await readJsonBody(req)
          if (typeof body.workflow_id !== 'string') throw new Error('workflow_id is required')
          const bodySessionId = typeof body.session_id === 'string' ? body.session_id : undefined
          const actionId = typeof body.action_id === 'string' ? body.action_id : randomUUID()
          const result = await actions.run(actionId, 'reject', bodySessionId, async () => {
            await requireWorkflow().reject(body.workflow_id as string, typeof body.reason === 'string' ? body.reason : undefined, bodySessionId)
            return { rejected: true }
          }, body)
          sendJson(res, 200, { ok: true, action_id: result.action_id, replayed: result.replayed, ...result.result })
          return
        }
        res.writeHead(404)
        res.end()
      } catch (error) {
        sendError(res, error)
      }
    },
  }), 'edmore.api')

}
