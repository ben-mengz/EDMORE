import type { Context } from '@deepseek-ai/cordis'
import type { ServerResponse } from 'node:http'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { dirname, extname, join } from 'node:path'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-host-webserver'
export const name = 'edmore-webui'
export const inject = ['webServer']
export const Config = z.object({ path: z.string().default('/edmore') })
declare module '@deepseek-ai/cordis' { interface Context { edmoreWebUi: boolean } }
export function apply(ctx: Context, config: { path: string }) {
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: config.path, handler: async (req, res) => {
    await serveStatic(res, dirname(import.meta.dirname), new URL(req.url ?? '/', 'http://x').pathname)
  } }), 'edmore.webui')
  ctx.provide('edmoreWebUi', true)
}
export const STATIC_MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
}
export async function serveStatic(res: ServerResponse, packageRoot: string, pathname: string): Promise<void> {
  const file = pathname === '/edmore' || pathname === '/edmore/' ? 'index.html' : pathname.replace(/^\/edmore\//, '')
  const target = join(packageRoot, 'static', file)
  try {
    const info = await stat(target)
    if (!info.isFile()) {
      res.writeHead(404)
      res.end()
      return
    }
    res.writeHead(200, {
      'content-type': STATIC_MIME[extname(target)] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    })
    createReadStream(target).pipe(res)
  } catch {
    res.writeHead(404)
    res.end()
  }
}
