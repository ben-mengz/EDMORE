import { messages } from '../locale.mjs'
import { skillsView } from './skills.js'
import { mcpEditor } from './mcp.js'
const $ = id => document.getElementById(id)
let busy = false, current, language = 'en', inventory, pluginBusy = false, pluginNotice = '', weknoraBusy = false
const t = key => messages(language)[key] ?? key
const mcpSettings = mcpEditor($('mcp-settings'), { list: () => window.edmore.mcp('list'), save: value => window.edmore.mcp('save', value), language: () => language })
function showError(error) { $('error').hidden = false; $('error').textContent = t(error.message ?? error) }
function translate(id) {
  language = id
  document.documentElement.lang = id === 'zh' ? 'zh-CN' : 'en'
  $('language').value = id
  $('language').ariaLabel = t('language')
  document.querySelectorAll('[data-i18n]').forEach(node => { node.textContent = t(node.dataset.i18n) })
  if (current) render(current)
  renderPlugins()
  skillsView.translate(id)
  mcpSettings.translate()
}
function render(state) {
  current = state
  const remote = state.remote === true
  $('remote-account').hidden = !remote
  $('remote-identity').textContent = `${t('remoteMode')} · ${state.username || t('signin')}`
  $('cloud-admin').hidden = !state.isAdmin
  $('share-local-mcp').checked = Boolean(state.sharing?.enabled)
  $('share-local-mcp').disabled = busy || !remote || state.phase !== 'external'
  $('share-status').textContent = [state.sharing?.registered?.join(', '), state.sharing?.skipped?.length ? `${t('shareSkipped')}: ${state.sharing.skipped.join(', ')}` : ''].filter(Boolean).join(' · ')
  document.querySelector('[data-tab="plugins"]').disabled = remote
  document.querySelector('[data-tab="skills"]').disabled = remote
  $('demo-start').closest('section').hidden = remote
  $('demo-logs').closest('details').hidden = remote
  const wk = state.weknora ?? { phase: 'stopped' }
  $('weknora-toggle').checked = ['running', 'external', 'starting'].includes(wk.phase)
  $('weknora-toggle').disabled = weknoraBusy || ['starting', 'stopping', 'external'].includes(wk.phase)
  $('weknora-toggle-label').textContent = language === 'zh' ? '本地后端' : 'Local Backend'
  const backendRunning = ['running', 'external'].includes(wk.phase)
  $('weknora-backend-action').textContent = language === 'zh'
    ? ({ starting: '启动中…', stopping: '停止中…' })[wk.phase] || (backendRunning ? '停止后端' : '启动后端')
    : ({ starting: 'Starting…', stopping: 'Stopping…' })[wk.phase] || (backendRunning ? 'Stop Backend' : 'Start Backend')
  $('weknora-backend-action').disabled = remote || weknoraBusy || ['starting', 'stopping', 'external'].includes(wk.phase)
  $('weknora-backend-action').title = wk.phase === 'external'
    ? (language === 'zh' ? '此服务由其他进程启动，请从原启动位置停止' : 'Started outside this app; stop it from its original owner') : ''
  $('weknora-status').textContent = `${t(wk.phase)} · ${wk.url || 'http://127.0.0.1:8080'}${wk.error ? ` · ${wk.error}` : ''}`
  $('weknora-logs').textContent = wk.logs || ''
  const wiki = wk.wiki
  $('weknora-wiki-open').textContent = language === 'zh' ? '打开 Wiki' : 'Open Wiki'
  $('weknora-wiki-open').disabled = wiki?.phase !== 'enabled'
  $('weknora-wiki-status').textContent = wiki?.phase === 'enabled'
    ? (language === 'zh'
      ? `来源 ${wiki.sources} · 处理中 ${wiki.processing} · 失败 ${wiki.failed} · Wiki 页面 ${wiki.pages} · 待整理 ${wiki.pending} · 待检查 ${wiki.issues}`
      : `Sources ${wiki.sources} · Processing ${wiki.processing} · Failed ${wiki.failed} · Wiki pages ${wiki.pages} · Pending ${wiki.pending} · Issues ${wiki.issues}`)
    : (language === 'zh' ? `Wiki：${({ disabled: '未启用', unconfigured: '未配置', unavailable: '状态不可用' })[wiki?.phase] || '离线'}` : `Wiki: ${wiki?.phase || 'offline'}`)
  $('phase').textContent = t(remote && state.phase === 'external' ? 'connected' : state.phase)
  const online = ['running', 'external'].includes(state.phase)
  $('dot').dataset.online = String(online)
  $('pid').textContent = state.pid ? `PID ${state.pid}` : ''
  $('external').hidden = remote || state.phase !== 'external'
  $('error').hidden = !state.error
  $('error').textContent = t(state.errorKey ?? state.error)
  $('logs').textContent = state.logs || t('noLogs')
  const changing = busy || ['starting', 'stopping'].includes(state.phase)
  const demo = state.demo ?? { phase: 'stopped' }
  $('demo-kind').disabled = changing || ['starting', 'running', 'stopping'].includes(demo.phase)
  if (demo.kind && ['starting', 'running', 'stopping'].includes(demo.phase)) $('demo-kind').value = demo.kind
  $('demo-start').disabled = changing || ['starting', 'stopping'].includes(demo.phase) || (demo.phase === 'running' && online)
  $('demo-stop').disabled = changing || !['running', 'error'].includes(demo.phase)
  $('demo-stop-external').hidden = !demo.externalMcp
  $('demo-stop-external').disabled = changing || ['starting', 'stopping'].includes(demo.phase)
  $('demo-external-status').hidden = !demo.externalMcp
  $('demo-external-status').textContent = demo.externalMcp ? `${t('demoExternal')} · :8010 · PID ${demo.externalMcp.pid}` : ''
  $('demo-status').textContent = `${t(demo.phase === 'stopped' && demo.externalMcp ? 'external' : demo.phase)}${demo.detail ? ` · ${demo.detail}` : ''}`
  $('demo-logs').textContent = demo.logs || t('noLogs')
  $('demo-status').title = `MCP: ${demo.twin ?? '-'}; Viewer: ${demo.viewer ?? '-'}`
  $('start').disabled = changing || state.owned || online
  $('start').textContent = t(remote ? 'connect' : 'start')
  $('stop').textContent = t(remote ? 'disconnect' : 'stop')
  $('stop').disabled = changing || (remote ? state.phase === 'stopped' : !state.owned)
  $('restart').hidden = remote
  $('restart').disabled = changing || !state.owned
  $('open').disabled = changing || (!remote && !online)
  $('probe').disabled = changing || !online
  $('empty').hidden = state.mcp.length > 0
  $('mcp').replaceChildren(...state.mcp.map(row => {
    const tr = document.createElement('tr')
    for (const value of [row.name, t(row.status), row.tools ?? '—']) {
      const td = document.createElement('td'); td.textContent = value; tr.append(td)
    }
    tr.children[1].className = row.status
    tr.children[1].title = row.error || ''
    return tr
  }))
  $('updated').textContent = new Date().toLocaleTimeString(language === 'zh' ? 'zh-CN' : 'en-GB')
  const packageLocked = state.owned || online || changing || pluginBusy
  $('plugin-install').querySelector('button').disabled = packageLocked
  $('plugin-install').querySelector('button').title = packageLocked ? t('packageStopped') : ''
}

function renderPlugins() {
  $('plugins-message').textContent = pluginNotice ? t(pluginNotice) : ''
  if (!inventory) return
  $('plugin-rows').replaceChildren(...inventory.rows.map(row => {
    const tr = document.createElement('tr')
    const local = row.name?.startsWith('file:')
    const name = document.createElement('td'); name.textContent = row.displayName || (local ? row.id : row.name || row.id); name.title = row.name
    const id = document.createElement('small'); id.textContent = local ? t('localPlugin') : row.id || ''; name.append(id)
    const enabled = document.createElement('td')
    const toggle = document.createElement('input'); toggle.type = 'checkbox'; toggle.checked = !row.disabled
    toggle.indeterminate = row.conditional && !row.overridden
    toggle.disabled = pluginBusy || !row.id || Boolean(row.parent) || row.kind === 'package' || row.required === true
    toggle.setAttribute('aria-label', `${t('enabled')}: ${row.displayName || row.name || row.id}`)
    toggle.addEventListener('change', () => pluginAction('toggle', { id: row.id, enabled: toggle.checked }, 'pluginPending'))
    enabled.append(toggle)
    const source = document.createElement('td'); source.textContent = t(row.source)
    const actions = document.createElement('td')
    if (row.overridden) {
      const reset = document.createElement('button'); reset.textContent = '↶'; reset.title = t('reset'); reset.ariaLabel = t('reset'); reset.disabled = pluginBusy
      reset.addEventListener('click', () => pluginAction('toggle', { id: row.id, enabled: null }, 'pluginPending'))
      actions.append(reset)
    }
    if (row.removable) {
      const remove = document.createElement('button'); remove.textContent = t('remove')
      remove.disabled = pluginBusy || current?.owned || ['running', 'external', 'starting', 'stopping'].includes(current?.phase)
      remove.addEventListener('click', () => pluginAction('remove', { id: row.id }, 'removed'))
      actions.append(remove)
    }
    tr.append(name, enabled, source, actions)
    return tr
  }))
}

async function pluginAction(operation, value, notice = '') {
  if (pluginBusy) return
  pluginBusy = true; pluginNotice = 'working'; renderPlugins(); if (current) render(current)
  try {
    if (operation === 'toggle') {
      const preview = await window.edmore.plugins('previewToggle', value)
      if (preview.changes.some(change => change.id !== value.id)) {
        const heading = language === 'zh' ? '以下插件将一起调整，是否继续？' : 'Apply these related plugin changes?'
        const details = preview.changes.map(change => `${change.disabled ? '-' : '+'} ${change.id}`).join('\n')
        if (!window.confirm(`${heading}\n\n${details}`)) return
      }
      value = { ...value, changes: preview.changes }
    }
    inventory = await window.edmore.plugins(operation, value); pluginNotice = inventory.notice || notice || (inventory.rows.length ? '' : 'noPlugins')
  }
  catch (error) { pluginNotice = error.message.replace(/^Error invoking remote method '[^']+': Error: /, ''); showError(error) }
  finally { pluginBusy = false; renderPlugins(); if (current) render(current) }
}
function selectTab(name) {
  if (!['overview', 'plugins', 'skills', 'settings'].includes(name)) return
  if (current?.remote && ['plugins', 'skills'].includes(name)) { void window.edmore.action('admin'); return }
  document.querySelectorAll('[data-tab]').forEach(button => { button.setAttribute('aria-selected', String(button.dataset.tab === name)) })
  document.querySelectorAll('main > [role=tabpanel]').forEach(view => { view.hidden = view.id !== `view-${name}` })
  if (name === 'plugins') void pluginAction('list')
  if (name === 'plugins') void window.edmore.weknora('read').then(result => {
    $('weknora-settings').elements.knowledgeBaseId.value = result.knowledgeBaseId
    $('weknora-settings').elements.apiKey.placeholder = result.configured ? (language === 'zh' ? '已保存；留空保留' : 'Saved; leave blank to keep') : ''
  }).catch(showError)
  if (name === 'skills') void skillsView.open()
  if (name === 'settings') void mcpSettings.open()
}
document.querySelectorAll('[data-tab]').forEach(button => button.addEventListener('click', () => selectTab(button.dataset.tab)))
document.querySelectorAll('[data-action]').forEach(button => button.addEventListener('click', async () => {
  busy = true; render(current)
  let failure
  try { const action = button.dataset.action === 'demoStart' && $('demo-kind').value === 'tem' ? 'demoStartTem' : button.dataset.action; const result = await window.edmore.action(action); if (!result.ok) failure = result.error }
  catch (error) { failure = error.message }
  finally { busy = false; render(current); if (failure) showError(failure) }
}))
$('plugins-refresh').addEventListener('click', () => pluginAction('list'))
$('plugin-install').addEventListener('submit', event => {
  event.preventDefault()
  try {
    const config = JSON.parse(event.target.elements.config.value)
    if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error(t('invalidConfig'))
    void pluginAction('install', { spec: event.target.elements.spec.value.trim(), config }, 'installed')
  } catch { pluginNotice = 'invalidConfig'; renderPlugins() }
})
$('settings').addEventListener('submit', async event => {
  event.preventDefault()
  try {
    const config = await window.edmore.configure(Object.fromEntries(new FormData(event.target)))
    $('endpoint').textContent = config.mode === 'remote' ? config.remoteUrl : config.baseUrl; $('saved').textContent = t('saved'); inventory = undefined
    await mcpSettings.open()
  } catch (error) { $('saved').textContent = error.message }
})
$('language').addEventListener('change', async event => {
  try { translate(await window.edmore.language(event.target.value)) } catch (error) { showError(error) }
})
window.edmore.subscribe(render)
$('share-local-mcp').addEventListener('change', async event => {
  const name = event.target.checked ? 'shareStart' : 'shareStop'
  busy = true; render(current)
  let failure
  try { const result = await window.edmore.action(name); if (!result.ok) failure = result.error }
  catch (error) { failure = error.message }
  finally { busy = false; render(current); if (failure) showError(failure) }
})
async function changeWeKnoraBackend(operation) {
  weknoraBusy = true; render(current)
  let failure
  try { await window.edmore.weknora(operation) } catch (error) { failure = error }
  finally { weknoraBusy = false; render(current); if (failure) $('weknora-saved').textContent = failure.message }
}
$('weknora-toggle').addEventListener('change', event => { void changeWeKnoraBackend(event.target.checked ? 'start' : 'stop') })
$('weknora-backend-action').addEventListener('click', () => {
  void changeWeKnoraBackend(current?.weknora?.phase === 'running' ? 'stop' : 'start')
})
$('weknora-wiki-open').addEventListener('click', () => { void window.edmore.weknora('open-wiki').catch(showError) })
$('weknora-settings').addEventListener('submit', async event => {
  event.preventDefault()
  try {
    await window.edmore.weknora('configure', Object.fromEntries(new FormData(event.target)))
    event.target.elements.apiKey.value = ''
    $('weknora-saved').textContent = language === 'zh' ? '已保存，重启 Harness 生效' : 'Saved; restart Harness to apply'
  } catch (error) { showError(error) }
})
window.edmore.onLanguage(translate)
window.edmore.onTab(selectTab)
const initial = await window.edmore.read()
for (const [key, value] of Object.entries(initial.config)) if ($('settings').elements[key]) $('settings').elements[key].value = value
$('endpoint').textContent = initial.config.mode === 'remote' ? initial.config.remoteUrl : initial.config.baseUrl
function connectionFields() {
  const remote = $('connection-mode').value === 'remote'
  $('remote-url-field').hidden = !remote
  $('settings').elements.remoteUrl.required = remote
  document.querySelectorAll('[data-local-setting]').forEach(node => {
    node.hidden = remote
    node.querySelectorAll('input').forEach(input => { input.required = !remote })
  })
}
$('connection-mode').addEventListener('change', connectionFields)
connectionFields()
translate(initial.language)
render(initial.state)
