import { mkdirSync, existsSync, readFileSync, writeFileSync, symlinkSync, realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

export function prepareClientProfile() {
  const root = dirname(fileURLToPath(import.meta.url))
  process.env.EDMORE_CLIENT_ROOT = root
  process.env.DSH_HOME = resolve(process.env.DSH_HOME || join(homedir(), '.dsh'))
  const profile = join(process.env.DSH_HOME, 'profiles', 'edmore-client')
  mkdirSync(profile, { recursive: true })
  const manifestPath = join(profile, 'package.json')
  const manifest = {
    name: 'edmore-client-profile', private: true,
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-edmore-backend-profile'], patchReload: 'startup' } },
  }
  if (existsSync(manifestPath)) {
    if (JSON.parse(readFileSync(manifestPath, 'utf8')).name !== manifest.name) {
      throw new Error(`Profile ${profile} belongs to another application`)
    }
  } else {
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' })
  }
  const modules = join(root, 'node_modules')
  if (!existsSync(modules)) throw new Error('Run npm ci in EDMORE/client before starting the client')
  const profileModules = join(profile, 'node_modules')
  if (!existsSync(profileModules)) {
    symlinkSync(modules, profileModules, process.platform === 'win32' ? 'junction' : 'dir')
  } else if (realpathSync(profileModules) !== realpathSync(modules)) {
    throw new Error(`Profile node_modules points to another installation: ${profileModules}`)
  }
  return { root, profile }
}
