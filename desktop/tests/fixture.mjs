import { createServer } from 'node:http'
const server = createServer((_req, res) => {
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify({ ok: true, application: 'edmore-client', nionswift: { ok: true, agents: ['test_mcp'] } }))
})
server.listen(0, '127.0.0.1', () => process.send({ port: server.address().port }))
process.on('message', message => {
  if (message.type === 'shutdown') server.close(() => process.exit(0))
})
