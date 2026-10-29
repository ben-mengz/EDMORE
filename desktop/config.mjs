import { readFile, writeFile, cp, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createHash } from 'node:crypto'

export function isClientRoot(root) {
  return typeof root === 'string' && existsSync(join(root, 'start.mjs')) && existsSync(join(root, 'profile.mjs'))
}

export function remoteOrigin(value) {
  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('Use an HTTP(S) server origin without a path or credentials')
  return url.origin
}

export async function loadDesktopConfig(dataDir, defaultRoot) {
  const path = join(dataDir, 'client.json')
  let saved = {}, legacy = false
  try { saved = JSON.parse(await readFile(path, 'utf8')) }
  catch (error) {
    if (error.code !== 'ENOENT') throw error
    try { saved = JSON.parse(await readFile(join(dataDir, 'harness.json'), 'utf8')); legacy = true }
    catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  const candidates = [process.env.EDMORE_CLIENT_DIR, saved.root,
    saved.root ? join(dirname(saved.root), 'EDMORE', 'client') : '', defaultRoot]
  const config = { root: candidates.find(isClientRoot) || '',
    node: saved.node || (process.platform === 'win32' ? 'node.exe' : '/opt/homebrew/bin/node'),
    profile: 'edmore-client', baseUrl: saved.baseUrl || 'http://127.0.0.1:7380',
    mode: saved.mode === 'remote' ? 'remote' : 'local', remoteUrl: saved.remoteUrl || '' }
  if (legacy && saved.root) {
    const key = value => createHash('sha256').update(JSON.stringify([value.root, value.profile, process.env.DSH_HOME ?? ''])).digest('hex').slice(0, 20)
    const oldPlugins = join(dataDir, 'plugins', key(saved))
    const newPlugins = join(dataDir, 'plugins', key(config))
    if (existsSync(oldPlugins) && !existsSync(newPlugins)) await cp(oldPlugins, newPlugins, { recursive: true })
  }
  await mkdir(dataDir, { recursive: true })
  await writeFile(path, JSON.stringify(config, null, 2) + '\n')
  return { path, config }
}
