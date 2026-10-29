#!/usr/bin/env node
import { prepareClientProfile } from "./profile.mjs"

if (process.env.EDMORE_AUTH === '1' && !process.env.EDMORE_AUTH_WORKER) {
  const { startAuthGateway } = await import('./packages/auth/src/index.mjs')
  await startAuthGateway()
} else {
  prepareClientProfile()
  process.argv = [process.execPath, 'dsh', '--profile', 'edmore-client', ...process.argv.slice(2)]
  const { runCli } = await import('@deepseek-ai/dsh/lib/bin.js')
  await runCli()
}
