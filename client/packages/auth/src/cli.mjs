import { resolve, join } from 'node:path'
import { homedir } from 'node:os'
import { readFile, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { Accounts, validatePassword, writeJson } from './store.mjs'

const home = resolve(process.env.DSH_HOME || join(homedir(), '.dsh'))
const [command, username, passwordFile] = process.argv.slice(2)
const accounts = new Accounts(join(home, 'auth/accounts.json'))
if (command === 'bootstrap' && /^[a-zA-Z0-9_-]{1,32}$/.test(username || '')) {
  if (!(await accounts.users.isEmpty())) throw new Error('Accounts already exist; bootstrap refused')
  const password = randomBytes(24).toString('base64url')
  await accounts.change(store => store.create(username, password, true))
  await writeJson(join(home, 'auth/users', username, 'plugins.json'), { 'edmore-wiki': true })
  const path = join(home, 'auth/initial-admin.txt')
  await writeFile(path, `Username: ${username}\nPassword: ${password}\n`, { mode: 0o600, flag: 'wx' })
  console.log(`Administrator created. Initial login details: ${path}`)
} else if (command === 'reset-password' && username && passwordFile) {
  const password = (await readFile(passwordFile, 'utf8')).trim()
  validatePassword(password)
  await accounts.change(store => store.setPassword(username, password))
  console.log('Password reset. Restart the auth gateway to revoke existing login sessions.')
} else {
  console.error('Usage: node --import tsx/esm packages/auth/src/cli.mjs bootstrap USERNAME\n       node --import tsx/esm packages/auth/src/cli.mjs reset-password USERNAME PASSWORD_FILE')
  process.exitCode = 2
}
