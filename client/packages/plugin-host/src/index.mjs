import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { satisfies } from 'semver'

export const hostApiVersion = 1
export const builtinPackages = ['wiki', 'remote', 'hu', 'bonsai', 'strata', 'tango'].map(id => `@edmore/plugin-${id}`)
export function featurePackages(env = process.env) {
  if (!env.EDMORE_FEATURE_PACKAGES) {
    const require = createRequire(import.meta.url)
    return builtinPackages.filter(name => {
      try { require.resolve(`${name}/plugin.json`); return true }
      catch (error) { if (error.code === 'MODULE_NOT_FOUND') return false; throw error }
    })
  }
  const selected = JSON.parse(env.EDMORE_FEATURE_PACKAGES)
  if (!Array.isArray(selected) || new Set(selected).size !== selected.length || selected.some(name => !builtinPackages.includes(name))) throw new Error('Invalid feature package selection')
  return selected
}
export function featureConfiguration(env = process.env) {
  return env.EDMORE_FEATURE_CONFIG || join(env.DSH_HOME || join(homedir(), '.dsh'), 'edmore/features.json')
}

export function resolveFeatures(manifests, disabled = []) {
  const rows = new Map()
  for (const row of manifests) {
    if (!row || row.hostApi !== hostApiVersion || !/^[a-z][a-z0-9-]*$/.test(row.id) || rows.has(row.id)
      || !Array.isArray(row.requires) || row.requires.some(id => typeof id !== 'string')) throw new Error('Invalid or duplicate feature manifest')
    rows.set(row.id, row)
  }
  for (const id of disabled) if (!rows.has(id)) throw new Error(`Unknown feature: ${id}`)
  const off = new Set(disabled), visiting = new Set(), visited = new Set(), ordered = []
  const visit = id => {
    if (visiting.has(id)) throw new Error(`Cyclic feature dependency: ${id}`)
    if (visited.has(id)) return
    const row = rows.get(id)
    if (!row || off.has(id)) throw new Error(`Missing or disabled feature dependency: ${id}`)
    visiting.add(id)
    for (const dependency of row.requires ?? []) visit(dependency)
    visiting.delete(id); visited.add(id); ordered.push(row)
  }
  for (const id of rows.keys()) if (!off.has(id)) visit(id)
  return ordered
}

export async function checkPackageDependencies(manifestPath) {
  const require = createRequire(manifestPath)
  const metadata = JSON.parse(await readFile(new URL('./package.json', pathToFileURL(manifestPath)), 'utf8'))
  const dependencies = { ...metadata.dependencies, ...metadata.peerDependencies }
  const resolved = []
  for (const [name, range] of Object.entries(dependencies)) {
    let found
    for (const directory of require.resolve.paths(name) || []) {
      try { found = JSON.parse(await readFile(join(directory, name, 'package.json'), 'utf8')); break }
      catch (error) { if (error.code !== 'ENOENT') throw error }
    }
    if (!found || found.name !== name || !satisfies(found.version, range, { includePrerelease: true })) throw new Error(`${metadata.name} requires ${name}@${range}; found ${found?.version || 'missing'}`)
    require.resolve(name)
    resolved.push({ name, version: found.version, range })
  }
  return resolved
}

export async function loadFeatures({ configuration = featureConfiguration(), packages = featurePackages() } = {}) {
  let disabled = []
  if (configuration) {
    let config
    try { config = JSON.parse(await readFile(configuration, 'utf8')) }
    catch (error) { if (error.code !== 'ENOENT' || process.env.EDMORE_FEATURE_CONFIG) throw error; config = { version: 1, disabled: [] } }
    if (config.version !== 1 || !Array.isArray(config.disabled) || config.disabled.some(x => typeof x !== 'string')) throw new Error('Invalid feature configuration')
    disabled = config.disabled
  }
  const require = createRequire(import.meta.url)
  const manifests = await Promise.all(packages.map(async name => {
    const manifest = JSON.parse(await readFile(require.resolve(`${name}/plugin.json`), 'utf8'))
    return { ...manifest, package: name }
  }))
  return resolveFeatures(manifests, disabled)
}

export async function modelProviderDefinitions(options) {
  const definitions = [], ids = new Set()
  const require = createRequire(import.meta.url)
  for (const feature of await loadFeatures(options)) {
    if (!feature.contributes?.modelProviders) continue
    const plugin = await import(pathToFileURL(require.resolve(feature.package)).href)
    for (const definition of plugin.modelProviders ?? []) {
      if (!/^[a-z0-9-]+$/.test(definition.id) || ids.has(definition.id) || !Number.isInteger(definition.concurrency) || definition.concurrency < 1) throw new Error('Invalid model provider contribution')
      ids.add(definition.id); definitions.push(definition)
    }
  }
  return definitions
}
