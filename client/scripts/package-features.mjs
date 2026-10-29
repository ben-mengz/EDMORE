import { readFile, mkdir, writeFile, cp, mkdtemp, rm } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { builtinPackages, loadFeatures } from '@edmore/plugin-host'

const root = fileURLToPath(new URL('..', import.meta.url))
const output = resolve(process.argv[2] || join(root, '../plugin-dist'))
await mkdir(output, { recursive: true })
const names = ['@edmore/plugin-host', ...builtinPackages, '@deepseek-ai/dsh-edmore-weknora-sync']
const packages = []
for (const name of names) {
  const result = JSON.parse(execFileSync('npm', ['pack', '--json', '--ignore-scripts', '--workspace', name, '--pack-destination', output], { cwd: root, encoding: 'utf8' }))[0]
  const bytes = await readFile(join(output, result.filename))
  const forbidden = result.files.filter(row => /(^|\/)(node_modules|\.env|data|\.dsh)(\/|$)|\.pem$|\.key$|harness\.env$|provision\.json$/.test(row.path))
  if (forbidden.length) throw new Error(`Private deployment files in package ${name}`)
  const directory = name === '@deepseek-ai/dsh-edmore-weknora-sync' ? 'weknora-sync' : name.split('/')[1]
  const metadata = JSON.parse(await readFile(join(root, 'packages', directory, 'package.json'), 'utf8'))
  const paths = new Set(result.files.map(row => row.path))
  const entries = [...Object.values(metadata.exports || {}), metadata.main].filter(x => typeof x === 'string' && !x.includes('*'))
  for (const entry of entries) if (!paths.has(entry.replace(/^\.\//, ''))) throw new Error(`Missing packaged entry ${name}:${entry}`)
  packages.push({ name, version: metadata.version, filename: result.filename,
    sha256: createHash('sha256').update(bytes).digest('hex'), dependencies: metadata.dependencies || {}, peerDependencies: metadata.peerDependencies || {}, files: paths.size })
}
const features = await loadFeatures({ configuration: null })
await writeFile(join(output, 'feature-kit.json'), JSON.stringify({ format: 1, hostApi: 1, packages, features }, null, 2) + '\n')
// A desktop build embeds only its plugin contributions, never deployment state.
const staging = await mkdtemp(join(tmpdir(), 'edmore-desktop-features-'))
try {
  for (const id of ['wiki', 'remote']) {
    const destination = join(staging, `plugin-${id}`)
    await mkdir(destination, { recursive: true })
    await cp(join(root, 'packages', `plugin-${id}`, 'desktop'), join(destination, 'desktop'), { recursive: true })
    await cp(join(root, 'packages', `plugin-${id}`, 'plugin.json'), join(destination, 'plugin.json'))
  }
  const desktop = join(root, '../desktop/feature-packages')
  await mkdir(desktop, { recursive: true })
  await cp(staging, desktop, { recursive: true })
} finally { await rm(staging, { recursive: true, force: true }) }
console.log(JSON.stringify({ output, packages: packages.map(p => ({ name: p.name, files: p.files })) }, null, 2))
