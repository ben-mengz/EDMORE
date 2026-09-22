#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { startTui } from './index.mjs'
const { values } = parseArgs({ options: { url: { type: 'string' }, session: { type: 'string' }, demo: { type: 'boolean' } } })
startTui(values)
