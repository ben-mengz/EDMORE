import { messages } from '../locale.mjs'
const $ = id => document.getElementById(id)
let busy = false, current, language = 'en', inventory, pluginBusy = false, pluginNotice = ''
const t = key => messages(language)[key] ?? key
function showError(error) { $('error').hidden = false; $('error').textContent = t(error.message ?? error) }
function translate(id) {
  language = id
  document.documentElement.lang = id === 'zh' ? 'zh-CN' : 'en'
  $('language').value = id
  $('language').ariaLabel = t('language')
  document.querySelectorAll('[data-i18n]').forEach(node => { node.textContent = t(node.dataset.i18n) })
  if (current) render(current)
  renderPlugins()
}
function render(state) {
  current = state
  $('phase').textContent = t(state.phase)
  const online = ['running', 'external'].includes(state.phase)
  $('dot').dataset.online = String(online)
  $('pid').textContent = state.pid ? `PID ${state.pid}` : ''
  $('external').hidden = state.phase !== 'external'
  $('error').hidden = !state.error
  $('error').textContent = t(state.errorKey ?? state.error)
  $('logs').textContent = state.logs || t('noLogs')
  const changing = busy || ['starting', 'stopping'].includes(state.phase)
  $('start').disabled = changing || state.owned || online
  $('stop').disabled = changing || !state.owned
  $('restart').disabled = changing || !state.owned
  $('open').disabled = changing || !online
  $('probe').disabled = changing || !online || !state.mcp.length
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
    const name = document.createElement('td'); name.textContent = local ? row.id : row.name || row.id; name.title = row.name
    const id = document.createElement('small'); id.textContent = local ? t('localPlugin') : row.id || ''; name.append(id)
    const enabled = document.createElement('td')
    const toggle = document.createElement('input'); toggle.type = 'checkbox'; toggle.checked = !row.disabled
    toggle.indeterminate = row.conditional && !row.overridden
    toggle.disabled = pluginBusy || !row.id || Boolean(row.parent) || row.kind === 'package'
    toggle.setAttribute('aria-label', `${t('enabled')}: ${row.name || row.id}`)
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
  try { inventory = await window.edmore.plugins(operation, value); pluginNotice = inventory.notice || notice || (inventory.rows.length ? '' : 'noPlugins') }
  catch (error) { pluginNotice = error.message.replace(/^Error invoking remote method '[^']+': Error: /, ''); showError(error) }
  finally { pluginBusy = false; renderPlugins(); if (current) render(current) }
}
function selectTab(name) {
  if (!['overview', 'plugins', 'settings'].includes(name)) return
  document.querySelectorAll('[data-tab]').forEach(button => { button.setAttribute('aria-selected', String(button.dataset.tab === name)) })
  document.querySelectorAll('[role=tabpanel]').forEach(view => { view.hidden = view.id !== `view-${name}` })
  if (name === 'plugins') void pluginAction('list')
}
document.querySelectorAll('[data-tab]').forEach(button => button.addEventListener('click', () => selectTab(button.dataset.tab)))
document.querySelectorAll('[data-action]').forEach(button => button.addEventListener('click', async () => {
  busy = true; render(current)
  let failure
  try { const result = await window.edmore.action(button.dataset.action); if (!result.ok) failure = result.error }
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
    $('endpoint').textContent = config.baseUrl; $('saved').textContent = t('saved'); inventory = undefined
  } catch (error) { $('saved').textContent = error.message }
})
$('language').addEventListener('change', async event => {
  try { translate(await window.edmore.language(event.target.value)) } catch (error) { showError(error) }
})
window.edmore.subscribe(render)
window.edmore.onLanguage(translate)
window.edmore.onTab(selectTab)
const initial = await window.edmore.read()
for (const [key, value] of Object.entries(initial.config)) if ($('settings').elements[key]) $('settings').elements[key].value = value
$('endpoint').textContent = initial.config.baseUrl
translate(initial.language)
render(initial.state)
