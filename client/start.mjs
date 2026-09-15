#!/usr/bin/env node
import { prepareClientProfile } from "./profile.mjs"

prepareClientProfile()
process.argv = [process.execPath, 'dsh', '--profile', 'edmore-client', ...process.argv.slice(2)]
const { runCli } = await import('./runtime/cli/lib/bin.js')
await runCli()
