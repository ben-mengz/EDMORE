import { mkdir, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { resolve, join, isAbsolute } from 'node:path'
import { parseArgs } from 'node:util'
import { pathToFileURL } from 'node:url'
import { endpoint } from './access.mjs'

export async function prepareAccess({ directory, issuer, registrationUrl, mcpUrl, registrationState, caFile }) {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(issuer || '')) throw new Error('An explicit stable issuer name is required')
  if (!isAbsolute(registrationState || '')) throw new Error('Registration state must be an absolute path')
  endpoint(registrationUrl); endpoint(mcpUrl)
  const root = resolve(directory), secret = randomBytes(48).toString('base64url')
  // Refuse reuse so a repeated setup cannot silently rotate a live identity key.
  await mkdir(root, { mode: 0o700 })
  const harnessFile = join(root, 'harness-access.json'), gatewayFile = join(root, 'gateway-access.json')
  await writeFile(harnessFile, JSON.stringify({ version: 1, issuer, signingSecret: secret, registrationUrl, mcpUrl, ...(caFile ? { caFile: resolve(caFile) } : {}) }, null, 2), { mode: 0o600, flag: 'wx' })
  await writeFile(gatewayFile, JSON.stringify({ version: 1, issuers: { [issuer]: { secret, allow_admin: true } },
    registration_state_file: registrationState, policy_file: join(root, 'device-policy.json'), read_tools: [] }, null, 2), { mode: 0o600, flag: 'wx' })
  return { harnessFile, gatewayFile }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: Object.fromEntries(['directory', 'issuer', 'registration-url', 'mcp-url', 'registration-state', 'ca-file'].map(name => [name, { type: 'string' }])) })
  for (const name of ['directory', 'issuer', 'registration-url', 'mcp-url', 'registration-state']) if (!values[name]) throw new Error(`Missing --${name}`)
  console.log(JSON.stringify(await prepareAccess({ directory: values.directory, issuer: values.issuer, registrationUrl: values['registration-url'], mcpUrl: values['mcp-url'], registrationState: values['registration-state'], caFile: values['ca-file'] }), null, 2))
}
