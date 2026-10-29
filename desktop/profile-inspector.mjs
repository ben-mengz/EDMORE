import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'

const [root, profile, operation, spec] = process.argv.slice(2)
if (profile !== 'edmore-client') throw new Error('EDMORE Desktop requires the edmore-client profile')
const { prepareClientProfile } = await import(pathToFileURL(join(root, 'profile.mjs')).href)
prepareClientProfile()
if (!['list', 'mcp'].includes(operation)) {
  process.argv = [process.execPath, 'dsh', 'plugin', '--profile', profile, operation, spec]
  const { runCli } = await import(pathToFileURL(join(root, 'runtime/cli/lib/bin.js')).href)
  await runCli()
} else {
  const require = createRequire(join(root, 'runtime/cli/package.json'))
  const boot = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-app-boot')).href)
  const { resolveDshHome } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-home-paths')).href)
  const anchor = join(root, 'runtime/cli/package.json')
  const loaded = boot.loadProfile('edmore-desktop', profile, anchor)
  const { features } = await import(pathToFileURL(join(root, 'packages/core/features.mjs')).href)
  const rows = boot.composeEntries([
    ...loaded.layers.map(layer => layer.patches), loaded.patches,
    boot.loadOptionalPatches('edmore-desktop', join(resolveDshHome(), 'cordis.patch.yml')) ?? [],
  ])
  // Expose metadata only; config values and !!js expressions never reach the renderer.
  const walk = (entries, parent = '') => entries.flatMap((row, index) => {
    const id = typeof row.id === 'string' ? row.id : null
    const name = row.name === '@deepseek-ai/dsh-edmore-optional-feature' && typeof row.config?.module === 'string'
      ? row.config.module : typeof row.name === 'string' ? row.name : ''
    return [{ id, name, displayName: features[id]?.displayName, parent, disabled: row.disabled === true,
      ...(operation === 'mcp' && name === '@deepseek-ai/dsh-mcp-client' ? { mcpConfig: row.config } : {}),
      mcpServerName: typeof row.config?.serverName === 'string' ? row.config.serverName : undefined,
      mcpConnection: name === '@deepseek-ai/dsh-mcp-client' && row.config?.transport === 'streamable-http' && typeof row.config?.url === 'string'
        ? { id: row.config.serverName, kind: 'standard', transport: 'streamable-http', url: row.config.url, enabled: row.disabled !== true,
          secretConfigured: Boolean(Object.keys(row.config.headers ?? {}).length) } : undefined,
      required: features[id]?.required ?? false, requires: features[id]?.requires ?? [],
      conditional: row.disabled !== undefined && typeof row.disabled !== 'boolean', index },
    ...(Array.isArray(row.config) ? walk(row.config, id ?? parent) : [])]
  })
  process.stdout.write(JSON.stringify({ rows: walk(rows), bundles: loaded.layers.map(layer => layer.packageName) }))
}
