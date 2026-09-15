import { messages } from './locale.mjs'

export function trayTemplate(state, language, commands) {
  const t = messages(language)
  const online = ['running', 'external'].includes(state.phase)
  const changing = ['starting', 'stopping'].includes(state.phase)
  return [
    { label: `EDMORE · ${t[state.phase]}`, enabled: false },
    { id: 'harness-toggle', label: t.harnessSwitch, type: 'checkbox', checked: online || state.owned,
      enabled: !changing && state.phase !== 'external', click: () => commands.action(state.owned ? 'stop' : 'start') },
    { label: t.restart, enabled: state.owned && !changing, click: () => commands.action('restart') },
    { type: 'separator' },
    { id: 'panel', label: t.panel, click: commands.panel },
    { label: t.open, enabled: online, click: () => commands.action('open') },
    { label: t.plugins, click: commands.plugins },
    { type: 'separator' },
    ...state.mcp.map(row => ({ label: `${row.name} · ${t[row.status]}`, enabled: false })),
    { type: 'separator' },
    { label: t.language, submenu: ['zh', 'en'].map(id => ({ label: id === 'zh' ? '中文' : 'English', type: 'radio', checked: language === id, click: () => commands.language(id) })) },
    { id: 'background', label: t.background, click: commands.background },
    { id: 'quit-completely', label: t.fullQuit, click: commands.quit },
  ]
}
