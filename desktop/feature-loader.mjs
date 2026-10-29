import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export function featureEnabled(id) {
  const path = process.env.EDMORE_FEATURE_CONFIG || join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'edmore/features.json')
  if (!existsSync(path)) {
    if (process.env.EDMORE_FEATURE_CONFIG) throw new Error('Feature configuration is missing')
    return true
  }
  const config = JSON.parse(readFileSync(path, 'utf8'))
  if (config.version !== 1 || !Array.isArray(config.disabled)) throw new Error('Invalid feature configuration')
  return !config.disabled.includes(id)
}

// Packaged apps carry the same feature package payloads as the source workspace.
export function loadFeatureModule(id, entry) {
  if (!/^[a-z][a-z0-9-]*$/.test(id) || !/^[a-zA-Z0-9./-]+$/.test(entry) || entry.split('/').includes('..')) throw new Error('Invalid feature entry')
  const bundled = new URL(`./feature-packages/plugin-${id}/${entry}`, import.meta.url)
  const source = new URL(`../client/packages/plugin-${id}/${entry}`, import.meta.url)
  return import((existsSync(source) ? source : bundled).href)
}
