import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-edmore-session-state'
import type { IncomingMessage, ServerResponse } from 'node:http'

export const name = 'edmore-session-state-api'
export const inject = ['webServer', 'edmoreSessionState']
declare module '@deepseek-ai/cordis' {
  interface Context { edmoreSessionStateApi: boolean }
}
export function apply(ctx: Context): void {
  const store = ctx.edmoreSessionState
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix', path: '/api/edmore-session-state',
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      res.setHeader('Cache-Control', 'no-store')
      res.setHeader('X-Content-Type-Options', 'nosniff')
      try {
        if (req.method !== 'GET') { res.statusCode = 405; res.end(); return }
        const url = new URL(req.url || '/', 'http://localhost')
        const path = url.pathname.slice('/api/edmore-session-state'.length)
        await store.flush()
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        if (path === '/sessions') { res.end(JSON.stringify({ sessions: store.sessions() })); return }
        const sessionId = url.searchParams.get('session_id')
        if (!sessionId) throw new Error('session_id is required')
        if (path === '/stream') {
          res.setHeader('Content-Type', 'text/event-stream')
          res.setHeader('Connection', 'keep-alive')
          const send = (version: number) => res.write(`data: ${JSON.stringify({ session_id: sessionId, version })}\n\n`)
          send(store.state(sessionId).version)
          const unsubscribe = store.subscribe((event, version) => { if (event.session_id === sessionId) send(version) })
          const keepalive = setInterval(() => res.write(': keepalive\n\n'), 15000)
          res.on('close', () => { unsubscribe(); clearInterval(keepalive) })
          return
        }
        if (path === '/state') { res.end(JSON.stringify(store.state(sessionId))); return }
        if (path === '/evidence') {
          const workflowId = url.searchParams.get('workflow_id')
          if (!workflowId) throw new Error('workflow_id is required')
          const through = url.searchParams.has('version') ? Number(url.searchParams.get('version')) : undefined
          if (through !== undefined && (!Number.isSafeInteger(through) || through < 0 || through > store.state(sessionId).version)) throw new Error('Invalid evidence version')
          res.end(JSON.stringify(store.evidence(sessionId, [workflowId], through))); return
        }
        if (path === '/events') {
          const after = Number(url.searchParams.get('after') || 0)
          const limit = Number(url.searchParams.get('limit') || 100)
          if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1) throw new Error('Invalid pagination')
          const events = store.events(sessionId, after, limit)
          res.end(JSON.stringify({ events, next_cursor: events.at(-1)?.version ?? after })); return
        }
        if (path === '/export') {
          res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8')
          res.setHeader('Content-Disposition', 'attachment; filename="edmore-session-trajectory.jsonl"')
          res.end(store.exportTrajectory(sessionId)); return
        }
        res.statusCode = 404; res.end(JSON.stringify({ error: 'Unknown session-state endpoint' }))
      } catch (error) {
        res.statusCode = 400
        res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
      }
    },
  }), 'edmore.session-state-api')
  ctx.provide('edmoreSessionStateApi', true)
}
