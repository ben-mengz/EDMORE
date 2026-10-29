const bad = message => Object.assign(new Error(message), { status: 400 })

export function normalizeMcp(input, old, { personal = false } = {}) {
  if (typeof input?.id !== 'string' || !/^[A-Za-z0-9_-]{1,32}$/.test(input.id)) throw bad('MCP name must contain 1 to 32 letters, numbers, underscores or hyphens')
  const kind = input.kind ?? old?.kind ?? 'standard'
  const transport = input.transport ?? 'streamable-http'
  if (!['standard', 'edmore'].includes(kind) || !['streamable-http', 'stdio'].includes(transport) || typeof input.enabled !== 'boolean') throw bad('Invalid MCP type, transport or enabled state')
  if (personal && transport !== 'streamable-http') throw bad('Personal connections support HTTP only')
  if (kind === 'edmore' && (input.id !== 'nionswift' || transport !== 'streamable-http')) throw bad('The EDMORE multi-agent connection must use the name nionswift and HTTP transport')
  if (kind !== 'edmore' && (input.id === 'nionswift' || input.id.startsWith('nionswift_'))) throw bad('The nionswift namespace is reserved for the EDMORE multi-agent connection')
  const row = { id: input.id, kind, transport, enabled: input.enabled }
  const secrets = input.secrets ?? (transport === 'stdio' ? old?.env : old?.headers) ?? {}
  if (!secrets || typeof secrets !== 'object' || Array.isArray(secrets) || Object.keys(secrets).length > 40 || Object.entries(secrets).some(([k,v]) => !/^[A-Za-z0-9_-]+$/.test(k) || typeof v !== 'string' || v.length > 8192 || /[\r\n]/.test(v))) throw bad('Secrets must be a JSON object of single-line strings')
  if (transport === 'streamable-http') {
    let url; try { url = new URL(input.url) } catch { throw bad('Invalid MCP URL') }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw bad('Use an HTTP(S) URL without credentials, query or fragment')
    row.url = url.href; row.headers = secrets
  } else {
    if (typeof input.command !== 'string' || !input.command.trim() || input.command.length > 1024) throw bad('A command is required')
    if (!Array.isArray(input.args) || input.args.length > 64 || input.args.some(v => typeof v !== 'string' || v.length > 4096)) throw bad('Arguments must be a JSON array of strings')
    row.command = input.command.trim(); row.args = input.args; row.env = secrets
  }
  return row
}

export function publicMcp({ headers, env, profileConfig, ...row }) {
  return { ...row, secretConfigured: Boolean(row.secretConfigured || Object.keys(headers || {}).length || Object.keys(env || {}).length) }
}

export function mcpPatch(rows, prefix, workspace) {
  const entries = rows.filter(row => !row.profileId && row.kind !== 'edmore' && row.enabled).map(row => ({
    id: `${prefix}-mcp-${row.id}`, name: '@deepseek-ai/dsh-mcp-client', config: {
      serverName: row.id, transport: row.transport, failOnStartupError: false,
      ...(row.transport === 'stdio' ? { command: row.command, args: row.args, env: row.env, cwd: workspace } : { url: row.url, headers: row.headers }),
    },
  }))
  const patch = entries.length ? [{ insert: entries }] : []
  for (const row of rows.filter(row => row.profileId)) patch.push({ id: row.profileId, disabled: !row.enabled, config: {
    ...row.profileConfig, url: row.url, ...(row.preserveHeaders ? {} : { headers: row.headers }),
  } })
  const edmore = rows.find(row => row.kind === 'edmore')
  if (edmore) patch.push({ id: 'edmore-mcp-bridge', disabled: !edmore.enabled, config: { id: 'edmore-mcp-bridge', module: '@deepseek-ai/dsh-edmore-mcp-bridge', options: { baseUrl: edmore.url, headers: edmore.headers, pollMs: 3000 } } })
  return patch
}
