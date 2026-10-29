import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { resolveFeatures, builtinPackages, checkPackageDependencies } from '@edmore/plugin-host'
import { readJson, writeJson } from '@edmore/plugin-host/storage'

const [command = 'list', id] = process.argv.slice(2)
const configuration = process.env.EDMORE_FEATURE_CONFIG || join(process.env.DSH_HOME || homedir() + '/.dsh', 'edmore/features.json')
const require = createRequire(import.meta.url)
const manifests = await Promise.all(builtinPackages.map(async name => ({
  ...JSON.parse(await readFile(require.resolve(`${name}/plugin.json`), 'utf8')), package: name,
})))
const state = await readJson(configuration, { version: 1, disabled: [] })
if (state.version !== 1 || !Array.isArray(state.disabled)) throw new Error('Invalid feature configuration')
if (['enable', 'disable'].includes(command)) {
  if (!manifests.some(p => p.id === id)) throw new Error('Unknown feature')
  const disabled = command === 'disable' ? [...new Set([...state.disabled, id])] : state.disabled.filter(x => x !== id)
  resolveFeatures(manifests, disabled)
  await writeJson(configuration, { version: 1, disabled })
  console.log(`Saved ${id}: ${command}. Restart the local Harness to apply; no service was restarted.`)
} else if (['list', 'doctor'].includes(command)) {
  const active = resolveFeatures(manifests, state.disabled)
  for (const manifest of manifests) console.log(JSON.stringify({ ...manifest, enabled: active.some(p => p.id === manifest.id) }))
  if (command === 'doctor') {
    for (const manifest of active) {
      const path = require.resolve(`${manifest.package}/plugin.json`)
      await checkPackageDependencies(path)
      for (const external of manifest.external || []) console.log(`${manifest.id}: external prerequisite (not started): ${external.name}`)
    }
    console.log('Package dependencies resolved. External services and credentials were not contacted.')
  }
} else throw new Error('Usage: node scripts/features.mjs [list|doctor|enable ID|disable ID]')
