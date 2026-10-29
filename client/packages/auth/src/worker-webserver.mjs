import WebServer from '@deepseek-ai/dsh-host-webserver'
import { Service } from '@deepseek-ai/cordis'
import { timingSafeEqual } from 'node:crypto'

// Guard every registered route, not just a fallback (exact routes win in Cordis).
export default class WorkerWebServer extends WebServer {
  authorized(req) {
    const expected = process.env.EDMORE_WORKER_TOKEN
    const supplied = req.headers['x-edmore-worker-token']
    return typeof expected === 'string' && expected.length >= 32 && typeof supplied === 'string' && Buffer.byteLength(expected) === Buffer.byteLength(supplied) && timingSafeEqual(Buffer.from(expected), Buffer.from(supplied))
  }
  protect(handler) {
    return (req, res) => {
      if (!this.authorized(req)) { res.writeHead(401); res.end(); return }
      return handler(req, res)
    }
  }
  register(route) { return super.register({ ...route, handler: this.protect(route.handler) }) }
  registerFallback(handler) { return super.registerFallback(this.protect(handler)) }
  registerUpgrade(route) {
    return super.registerUpgrade({ ...route, handler: (req, socket, head) => {
      if (!this.authorized(req)) { socket.destroy(); return }
      return route.handler(req, socket, head)
    } })
  }
  async [Service.init]() {
    if (!process.env.EDMORE_WORKER_TOKEN) throw new Error('Missing worker authentication token')
    await super[Service.init]()
    process.send?.({ type: 'edmore-worker-listening', port: this.port })
  }
}
