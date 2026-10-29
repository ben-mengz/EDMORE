import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, readFile, mkdir, readdir, symlink, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { resolveFeatures, modelProviderDefinitions, loadFeatures } from '../src/index.mjs'
import { tangoConnection } from '../../plugin-tango/src/index.mjs'
import { startLocalWikiPortal } from '../../plugin-wiki/src/local-portal.mjs'
import { startWikiServices } from '../../plugin-wiki/src/services.mjs'
import { remotePartition } from '../../plugin-remote/desktop/remote.mjs'

async function temporary(t) {
  const root = await mkdtemp(join(tmpdir(), 'edmore-features-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}

test('feature dependencies reject cycles, duplicates, unknown and disabled prerequisites', () => {
  const a = { id: 'a', hostApi: 1, requires: [] }, b = { id: 'b', hostApi: 1, requires: ['a'] }
  assert.deepEqual(resolveFeatures([b, a]).map(p => p.id), ['a', 'b'])
  assert.throws(() => resolveFeatures([b]), /Missing/)
  assert.throws(() => resolveFeatures([a, b], ['a']), /disabled/)
  assert.throws(() => resolveFeatures([a, b], ['unknown']), /Unknown/)
  assert.throws(() => resolveFeatures([{ ...a, requires: ['b'] }, b]), /Cyclic/)
  assert.throws(() => resolveFeatures([a, a]), /duplicate/)
  assert.throws(() => resolveFeatures([{ ...a, hostApi: 2 }]), /Invalid/)
})

test('HU and Strata are independent contributions; disabling one leaves the other enabled', async t => {
  const directory = await temporary(t), configuration = join(directory, 'features.json')
  await writeFile(configuration, JSON.stringify({ version: 1, disabled: ['strata'] }))
  const definitions = await modelProviderDefinitions({ configuration })
  assert.ok(definitions.some(p => p.id === 'llm3-hu' && p.concurrency === 4))
  assert.ok(!definitions.some(p => p.id === 'strata-local'))
  assert.ok((await modelProviderDefinitions({ configuration: null })).some(p => p.id === 'strata-local' && !p.required && p.concurrency === 1))
  await writeFile(configuration, '{}')
  await assert.rejects(loadFeatures({ configuration }), /Invalid/)
})

test('profile composes real Wiki and Tango bundles without version exemptions', async t => {
  const home = await temporary(t)
  const root = resolve('.')
  const program = `import {prepareClientProfile} from './profile.mjs';
    import {createRequire} from 'node:module'; prepareClientProfile();
    const require=createRequire(process.cwd()+'/package.json');
    const boot=await import(require.resolve('@deepseek-ai/dsh-app-boot'));
    const p=boot.loadProfile('test','edmore-client',process.cwd()+'/package.json');
    console.log(JSON.stringify({layers:p.layers.map(x=>x.packageName),skipped:p.skippedBundles}));`
  const env = { ...process.env, DSH_HOME: home }
  delete env.EDMORE_FEATURE_CONFIG
  const inspect = () => JSON.parse(execFileSync(process.execPath, ['--import', 'tsx/esm', '--input-type=module', '-e', program], { cwd: root, env, encoding: 'utf8' }))
  let result = inspect()
  assert.deepEqual(result.skipped || [], [])
  assert.ok(result.layers.includes('@edmore/plugin-wiki'))
  assert.ok(result.layers.includes('@edmore/plugin-tango'))
  await mkdir(join(home, 'edmore'), { recursive: true })
  await writeFile(join(home, 'edmore/features.json'), JSON.stringify({ version: 1, disabled: ['wiki'] }))
  result = inspect()
  assert.ok(!result.layers.includes('@edmore/plugin-wiki'))
  assert.ok(result.layers.includes('@edmore/plugin-tango'))
})

test('Tango stays disconnected by default and rejects credentials in URLs', () => {
  assert.equal(tangoConnection({}), undefined)
  assert.throws(() => tangoConnection({ EDMORE_TANGO_MCP_URL: 'http://user:password@localhost:8767/mcp' }), /Invalid/)
  const result = tangoConnection({ EDMORE_TANGO_MCP_URL: 'http://127.0.0.1:8767/mcp', EDMORE_TANGO_MCP_TOKEN: 'scoped' })
  assert.equal(result.headers.Authorization, 'Bearer scoped')
  assert.equal(result.serverName, 'tango')
})

test('desktop cloud identities are origin-scoped and reject embedded credentials', () => {
  assert.equal(remotePartition('http://localhost:7380/'), remotePartition('http://localhost:7380'))
  assert.notEqual(remotePartition('http://localhost:7380'), remotePartition('http://localhost:7381'))
  assert.throws(() => remotePartition('http://alice:secret@localhost:7380'), /credentials/)
  assert.throws(() => remotePartition('file:///tmp/example'), /HTTP/)
})

test('Wiki service adapter preserves external ownership and keeps lifecycle with its host', async t => {
  const root = await temporary(t)
  await writeFile(join(root, 'server.env'), 'SERVER_PORT=8080\n')
  await writeFile(join(root, 'harness.env'), 'WEKNORA_BASE_URL=http://127.0.0.1:8080\n')
  const env = { WEKNORA_DATA_DIR: root, WEKNORA_BINARY: '/fixture/wiki', WEKNORA_SERVICE_ROOT: root }
  await assert.rejects(startWikiServices({ env, fetchImpl: async () => ({ ok: true }), launch: () => assert.fail('must not adopt an external service') }), /already owned/)
  let probes = 0
  const launched = []
  const result = await startWikiServices({ env, fetchImpl: async () => ({ ok: probes++ > 0 }),
    launch: (...args) => { launched.push(args); return { exitCode: null, signalCode: null } } })
  assert.equal(launched.length, 1)
  assert.equal(launched[0][1], '/fixture/wiki')
  assert.equal(result.WEKNORA_BASE_URL, 'http://127.0.0.1:8080')
})

test('local Wiki portal requires one-use entry, rejects cross-origin writes and does not expose native tokens', async t => {
  const home = await temporary(t)
  await mkdir(join(home, 'auth/wiki'), { recursive: true })
  await writeFile(join(home, 'auth/wiki/alice.native.json'), JSON.stringify({ knowledgeBases: { Capabilities: 'private' } }))
  const portal = await startLocalWikiPortal({ home, username: 'alice', wiki: {
    browser: async () => ({ token: 'DO_NOT_EXPOSE', user: { username: 'alice' }, tenant: { id: 2 } }),
  } })
  t.after(() => portal.close())
  assert.equal((await fetch(portal.origin + '/auth/wiki/open')).status, 401)
  const entry = portal.entry()
  const login = await fetch(entry, { redirect: 'manual' })
  assert.equal(login.status, 303)
  assert.equal((await fetch(entry, { redirect: 'manual' })).status, 403)
  const cookie = login.headers.get('set-cookie').split(';')[0]
  const opened = await fetch(portal.origin + '/auth/wiki/open', { headers: { cookie } })
  assert.equal(opened.status, 200)
  assert.ok(!(await opened.text()).includes('DO_NOT_EXPOSE'))
  assert.equal((await fetch(portal.origin + '/api/v1/knowledge', { method: 'POST', headers: { cookie, origin: 'http://evil.invalid' } })).status, 403)
  assert.equal((await fetch(portal.origin + '/api/v1/system/admin/users', { headers: { cookie } })).status, 403)
})

test('packed feature modules load outside the source checkout with host dependencies supplied', async t => {
  const directory = await temporary(t), root = resolve('.'), dist = resolve('../plugin-dist')
  const kit = JSON.parse(await readFile(join(dist, 'feature-kit.json'), 'utf8'))
  const modules = join(directory, 'node_modules')
  await mkdir(modules, { recursive: true })
  const packed = new Set(kit.packages.map(p => p.name))
  for (const p of kit.packages) {
    const archive = join(dist, p.filename)
    assert.equal(createHash('sha256').update(await readFile(archive)).digest('hex'), p.sha256)
    const target = join(modules, p.name)
    await mkdir(target, { recursive: true })
    execFileSync('tar', ['-xzf', archive, '--strip-components=1', '-C', target])
  }
  // Only host/external dependencies are linked. Every feature must resolve to its archive.
  for (const scope of await readdir(join(root, 'node_modules'))) {
    if (scope.startsWith('.')) continue
    const names = scope.startsWith('@') ? (await readdir(join(root, 'node_modules', scope))).map(name => `${scope}/${name}`) : [scope]
    for (const name of names) {
      if (packed.has(name)) continue
      if (scope.startsWith('@')) await mkdir(join(modules, scope), { recursive: true })
      await symlink(join(root, 'node_modules', name), join(modules, name))
    }
  }
  const require = createRequire(join(directory, 'package.json'))
  for (const name of ['@edmore/plugin-wiki', '@edmore/plugin-hu', '@edmore/plugin-strata', '@edmore/plugin-tango']) {
    assert.ok(require.resolve(name).startsWith(await realpath(directory)))
    assert.ok(await import(pathToFileURL(require.resolve(name)).href))
  }
  const host = await import(pathToFileURL(require.resolve('@edmore/plugin-host')).href)
  assert.equal((await host.loadFeatures({ configuration: null })).length, 6)
})
