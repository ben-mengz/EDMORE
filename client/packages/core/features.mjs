// Configuration dependencies for the current composition; refined as modules move into Core.
export const features = {
  'edmore-weknora-sync': { requires: ['edmore-core', 'skills', 'tools'], service: 'edmoreWeKnoraSync' },
  'edmore-tango': { requires: ['edmore-mcp-bridge', 'tools'] },
  'edmore-core': { required: true, requires: ['agent', 'agent-loop', 'session', 'session-persistence-jsonl', 'system-prompt', 'tools', 'skills', 'settings', 'credentials', 'llm', 'llm-pi-ai'], service: 'edmoreAgentLoop' },
  'edmore-session-state': { requires: ['edmore-core'], service: 'edmoreSessionState' },
  'edmore-session-state-api': { requires: ['webserver', 'edmore-session-state'], service: 'edmoreSessionStateApi' },
  'edmore-plan-judge': { displayName: 'Workflow Engine', requires: ['skills', 'edmore-session-state', 'edmore-core'], service: 'edmorePlanJudge' },
  'edmore-jev-decisions': { requires: ['edmore-plan-judge', 'credentials'], service: 'edmoreJevDecisions' },
  'edmore-workspace': { requires: [], service: 'edmoreWorkspace' },
  'edmore-workspace-api': { requires: ['webserver', 'edmore-workspace'], service: 'edmoreWorkspaceApi' },
  'edmore-mcp-bridge': { requires: ['edmore-core', 'tools'], service: 'edmoreMcpBridge' },
  'edmore-backend': { requires: ['webserver', 'edmore-core'], service: 'edmoreClientApi' },
  'edmore-webui': { requires: ['webserver', 'edmore-backend'], service: 'edmoreWebUi' },
  'edmore-conversation-title': { requires: ['edmore-core', 'edmore-workspace'], service: 'edmoreConversationTitle' },
}

export function dependencyReport(rows) {
  const byId = new Map(rows.map(row => [row.id, row]))
  return rows.map(row => {
    const specification = features[row.id]
    const dependencies = row.requires ?? specification?.requires ?? []
    const missing = dependencies.filter(id => !byId.has(id) || byId.get(id).disabled)
    return { ...row, required: row.required ?? specification?.required ?? false,
      requires: dependencies, missing_dependencies: missing,
      status: row.disabled ? 'disabled' : missing.length ? 'blocked' : 'configured' }
  })
}

export function assertDependencies(rows) {
  const report = dependencyReport(rows)
  const issues = report.flatMap(row => row.required && row.disabled
    ? [`${row.id} is required and cannot be disabled`]
    : !row.disabled && row.missing_dependencies.length
      ? [`${row.id} requires: ${row.missing_dependencies.join(', ')}`] : [])
  if (issues.length) throw new Error(`Invalid plugin configuration: ${issues.join('; ')}`)
  return report
}
