import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'

const [root, profile, operation, spec] = process.argv.slice(2)
if (profile !== 'edmore-client') throw new Error('EDMORE Desktop requires the edmore-client profile')
const { prepareClientProfile } = await import(pathToFileURL(join(root, 'profile.mjs')).href)
prepareClientProfile()
if (operation !== 'list') {
  process.argv = [process.execPath, 'dsh', 'plugin', '--profile', profile, operation, spec]
  const { runCli } = await import(pathToFileURL(join(root, 'runtime/cli/lib/bin.js')).href)
  await runCli()
} else {
  const require = createRequire(join(root, 'runtime/cli/package.json'))
  const boot = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-app-boot')).href)
  const { resolveDshHome } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-home-paths')).href)
  const anchor = join(root, 'runtime/cli/package.json')
  const loaded = boot.loadProfile('edmore-desktop', profile, anchor)
  const rows = boot.composeEntries([
    ...loaded.layers.map(layer => layer.patches), loaded.patches,
    boot.loadOptionalPatches('edmore-desktop', join(resolveDshHome(), 'cordis.patch.yml')) ?? [],
  ])
  // Expose metadata only; config values and !!js expressions never reach the renderer.
  const walk = (entries, parent = '') => entries.flatMap((row, index) => {
    const id = typeof row.id === 'string' ? row.id : null
    const name = typeof row.name === 'string' ? row.name : ''
    return [{ id, name, parent, disabled: row.disabled === true,
      conditional: row.disabled !== undefined && typeof row.disabled !== 'boolean', index },
    ...(Array.isArray(row.config) ? walk(row.config, id ?? parent) : [])]
  })
  process.stdout.write(JSON.stringify({ rows: walk(rows), bundles: loaded.layers.map(layer => layer.packageName) }))
}
