import { app, BrowserWindow, Menu, Tray, nativeImage, ipcMain, dialog, shell, session } from 'electron'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Supervisor } from './supervisor.mjs'
import { Demo } from './demo.mjs'
import { WeKnora } from './weknora.mjs'
import { PluginManager } from './plugins.mjs'
import { SkillManager } from './skills.mjs'
import { messages } from './locale.mjs'
import { trayTemplate } from './menus.mjs'
import { loadDesktopConfig, isClientRoot, remoteOrigin } from './config.mjs'
import { RemoteConnection, remotePartition } from './remote.mjs'
import { DeviceSharing } from './device-sharing.mjs'
import { installWikiNavigation } from './wiki-navigation.mjs'
import { featureEnabled } from './feature-loader.mjs'

const here = dirname(fileURLToPath(import.meta.url))
app.setName('EDMORE')
if (!app.isPackaged && process.env.EDMORE_DESKTOP_TEST_DATA_DIR) app.setPath('userData', process.env.EDMORE_DESKTOP_TEST_DATA_DIR)
let panel, workspace, tray, supervisor, plugins, demo, weknora, quitting = false, timer, quittingTask, workspaceLoadFailed = false
let language = 'en', preferencesPath, mutationBusy = false
const sharing = new DeviceSharing()
const panelUrl = pathToFileURL(join(here, 'renderer/index.html')).href
const t = key => messages(language)[key] ?? key
const remote = () => supervisor instanceof RemoteConnection
function createConnection(config) {
  if (config.mode === 'remote' && !featureEnabled('remote')) throw new Error('Enable the Cloud Connection plugin before using remote mode')
  const connection = config.mode === 'remote'
    ? new RemoteConnection(config, { request: (url, options) => session.fromPartition(remotePartition(config.remoteUrl)).fetch(url, options) })
    : new Supervisor(config)
  connection.on('state', publish)
  return connection
}
function localOnly() { if (remote()) throw new Error(t('remoteManagement')) }

function showPanel(tab = 'overview') {
  if (process.platform === 'darwin') void app.dock.show()
  if (panel && !panel.isDestroyed()) { panel.show(); panel.focus(); panel.webContents.send('edmore:tab', tab); return }
  panel = new BrowserWindow({ width: 1000, height: 740, minWidth: 720, minHeight: 560, title: 'EDMORE',
    webPreferences: { preload: join(here, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } })
  panel.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  panel.webContents.on('will-navigate', event => event.preventDefault())
  panel.on('close', event => { if (!quitting) { event.preventDefault(); background() } })
  panel.webContents.once('did-finish-load', () => panel.webContents.send('edmore:tab', tab))
  void panel.loadURL(panelUrl)
}

function background() {
  for (const window of BrowserWindow.getAllWindows()) window.hide()
  if (process.platform === 'darwin') app.dock.hide()
}

async function openWorkspace(path = '/edmore') {
  if (!remote() && !['running', 'external'].includes(supervisor.state.phase)) throw new Error(t('notReady'))
  if (remote()) supervisor.connected = true
  if (process.platform === 'darwin') void app.dock.show()
  if (workspace && !workspace.isDestroyed()) {
    workspace.show(); workspace.focus()
    if (path !== '/edmore' || workspaceLoadFailed) {
      try { await workspace.loadURL(`${supervisor.endpoint}${path}`); workspaceLoadFailed = false }
      catch (error) { workspaceLoadFailed = true; throw error }
    }
    return
  }
  const endpoint = supervisor.endpoint
  workspace = new BrowserWindow({ width: 1400, height: 920, title: 'EDMORE Workspace',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true,
      ...(remote() ? { partition: remotePartition(endpoint) } : {}) } })
  installWikiNavigation(workspace.webContents, endpoint, error => {
    workspaceLoadFailed = true
    dialog.showErrorBox('Open Wiki', error.message)
  })
  workspace.webContents.on('will-navigate', (event, url) => {
    if (new URL(url).origin !== new URL(endpoint).origin) event.preventDefault()
  })
  try { await workspace.loadURL(`${endpoint}${path}`); workspaceLoadFailed = false }
  catch (error) { workspaceLoadFailed = true; throw error }
}

function publish(state) {
  if (panel && !panel.isDestroyed()) panel.webContents.send('edmore:state', { ...state, sharing: sharing.state, demo: demo?.state, weknora: weknora?.state })
  if (!tray) return
  tray.setToolTip(`EDMORE · ${t(state.phase)}`)
  if (process.platform === 'darwin') tray.setTitle(`ED · ${t(state.phase)}`)
  tray.setContextMenu(Menu.buildFromTemplate(trayTemplate(state, language, {
    action: name => void action(name), panel: () => showPanel(), plugins: () => showPanel('plugins'),
    language: id => void changeLanguage(id), background, quit: () => app.quit(),
  })))
}

function applicationMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([{ label: 'EDMORE', submenu: [
    { label: t('panel'), accelerator: 'CmdOrCtrl+,', click: () => showPanel() },
    { label: t('plugins'), click: () => showPanel('plugins') },
    { type: 'separator' },
    { id: 'background', label: t('background'), accelerator: 'CmdOrCtrl+Q', click: background },
    { id: 'quit-completely', label: t('fullQuit'), accelerator: 'CmdOrCtrl+Shift+Q', click: () => app.quit() },
  ] }, { role: 'editMenu' }, { role: 'viewMenu' }]))
}

async function changeLanguage(id) {
  if (!['zh', 'en'].includes(id)) throw new Error('Invalid language')
  await writeFile(preferencesPath, JSON.stringify({ language: id }))
  language = id
  applicationMenu()
  if (panel && !panel.isDestroyed()) panel.webContents.send('edmore:language', language)
  publish(supervisor.state)
  return language
}

async function action(name) {
  let acquired = false
  try {
    if (remote() && name.startsWith('demo')) localOnly()
    if (['start', 'stop', 'restart', 'shareStart', 'shareStop', 'demoStart', 'demoStartTem', 'demoStop', 'demoStopExternal'].includes(name)) {
      if (mutationBusy) throw new Error(t('pluginBusy'))
      mutationBusy = true; acquired = true
    }
    if (plugins.busy && ['start', 'stop', 'restart', 'demoStart', 'demoStartTem', 'demoStop', 'demoStopExternal'].includes(name)) throw new Error(t('pluginBusy'))
    if (name === 'background') background()
    else if (name === 'open') await openWorkspace()
    else if (name === 'account') await openWorkspace('/account')
    else if (name === 'admin') await openWorkspace(supervisor.state.isAdmin ? '/admin' : '/account')
    else if (name === 'shareStart') {
      if (!remote()) throw new Error('Cloud mode is required')
      await sharing.start(supervisor, await plugins.localHttpMcp())
      publish(supervisor.state)
    }
    else if (name === 'shareStop') { await sharing.stop(); publish(supervisor.state) }
    else if (name === 'demoStop') await demo.stop()
    else if (name === 'demoStopExternal') {
      await demo.refreshExternal(supervisor.config.root)
      const expected = demo.state.externalMcp
      if (!expected) throw new Error(t('demoExternalMissing'))
      const { response } = await dialog.showMessageBox(panel, { type: 'warning',
        message: t('demoExternalConfirm'), detail: `AsyncroscopyDigitalTwin MCP :8010 (PID ${expected.pid})`,
        buttons: [t('demoCancel'), t('demoStopExternal')], defaultId: 0, cancelId: 0 })
      if (response === 1) {
        await demo.stop()
        await demo.stopExternal(supervisor.config.root, expected)
      }
    }
    else if (name === 'demoStart' || name === 'demoStartTem') {
      await demo.start(supervisor.config.root, name === 'demoStartTem' ? 'tem' : 'asyncroscopy')
      if (name === 'demoStartTem') await shell.openExternal('http://127.0.0.1:8768/')
      supervisor.config.pluginPatch = await plugins.writePatch()
      await supervisor.start()
      if (!['running', 'external'].includes(supervisor.state.phase)) throw new Error(supervisor.state.error || t('notReady'))
      await supervisor.probeMcp()
    }
    else {
      if (!remote() && (name === 'start' || name === 'restart')) supervisor.config.pluginPatch = await plugins.writePatch()
      if (name === 'stop' || name === 'restart') {
        await sharing.stop()
        if (workspace && !workspace.isDestroyed()) workspace.close()
      }
      await supervisor[name]()
      await supervisor.refresh()
      if (remote() && name === 'start') await openWorkspace()
      if (['running', 'external'].includes(supervisor.state.phase)) await supervisor.probeMcp()
    }
    return { ok: true }
  } catch (error) {
    supervisor.publish({ error: error.message })
    return { ok: false, error: error.message }
  } finally { if (acquired) mutationBusy = false }
}

async function main() {
  const dataDir = app.getPath('userData')
  await mkdir(dataDir, { recursive: true })
  preferencesPath = join(dataDir, 'preferences.json')
  try { language = JSON.parse(await readFile(preferencesPath, 'utf8')).language === 'zh' ? 'zh' : 'en' }
  catch (error) { if (error.code !== 'ENOENT') throw error; language = app.getLocale().startsWith('zh') ? 'zh' : 'en' }
  const { path: configPath, config } = await loadDesktopConfig(dataDir, app.isPackaged ? '' : resolve(here, '../client'))
  supervisor = createConnection(config)
  weknora = new WeKnora(config.root,{node:config.node})
  supervisor.extraEnv = featureEnabled('wiki') ? await weknora.environment() : {}
  weknora.on('state', () => publish(supervisor.state))
  await weknora.refresh()
  demo = new Demo()
  demo.on('state', () => publish(supervisor.state))
  plugins = new PluginManager(config, dataDir)
  const assertSender = event => {
    if (event.senderFrame !== panel?.webContents.mainFrame || event.senderFrame.url !== panelUrl) throw new Error('Untrusted desktop IPC sender')
  }
  ipcMain.handle('edmore:read', event => { assertSender(event); return { config: supervisor.config, state: { ...supervisor.state, sharing: sharing.state, demo: demo.state, weknora: weknora.state }, language } })
  ipcMain.handle('edmore:weknora', async (event, operation, value) => {
    assertSender(event)
    localOnly()
    if (!featureEnabled('wiki') && !['read', 'stop'].includes(operation)) throw new Error('Wiki plugin is disabled')
    if (operation === 'open-wiki') return shell.openExternal(await weknora.wikiUrl())
    if (operation === 'read') {
      const env = featureEnabled('wiki') ? await weknora.environment() : {}
      return { ...await weknora.refresh(), configured: Boolean(env.WEKNORA_API_KEY), knowledgeBaseId: env.WEKNORA_CAPABILITIES_KB_ID || '' }
    }
    if (mutationBusy || weknora.busy) throw new Error(t('lifecycleBusy'))
    mutationBusy = true
    try {
      if (operation === 'configure') {
        const result = await weknora.configure(value)
        supervisor.extraEnv = await weknora.environment()
        return result
      }
      if (operation === 'start') {
        const result = await weknora.start()
        supervisor.extraEnv = { ...await weknora.environment(), WEKNORA_BASE_URL: weknora.state.url }
        return result
      }
      if (operation === 'stop') return await weknora.stop()
      throw new Error('Unknown WeKnora operation')
    } finally { mutationBusy = false }
  })
  ipcMain.handle('edmore:language', (event, id) => { assertSender(event); return changeLanguage(id) })
  ipcMain.handle('edmore:action', (event, name) => {
    assertSender(event)
    if (!['start', 'stop', 'restart', 'shareStart', 'shareStop', 'demoStart', 'demoStartTem', 'demoStop', 'demoStopExternal', 'refresh', 'probeMcp', 'open', 'account', 'admin', 'background'].includes(name)) throw new Error('Unknown action')
    return action(name)
  })
  ipcMain.handle('edmore:plugins', async (event, operation, value) => {
    assertSender(event)
    localOnly()
    if (operation === 'list') return plugins.list()
    if (operation === 'previewToggle') return plugins.previewToggle(value?.id, value?.enabled)
    if (mutationBusy) throw new Error(t('pluginBusy'))
    mutationBusy = true
    try {
      if (supervisor.busy) throw new Error(t('lifecycleBusy'))
      if (operation === 'toggle') return await plugins.toggle(value?.id, value?.enabled, value?.changes)
      if (!['install', 'remove'].includes(operation)) throw new Error('Unknown plugin operation')
      await supervisor.refresh()
      await weknora.refresh()
      if (supervisor.child || supervisor.busy || !['stopped', 'error'].includes(supervisor.state.phase)) throw new Error(t('packageStopped'))
      return operation === 'install' ? await plugins.install(value?.spec, value?.config) : await plugins.remove(value?.id)
    } catch (error) { throw new Error(t(error.message)) }
    finally { mutationBusy = false }
  })
  ipcMain.handle('edmore:mcp', async (event, operation, value) => {
    assertSender(event)
    if (remote()) {
      if (!['list', 'save'].includes(operation)) throw new Error('Unknown MCP operation')
      if (operation === 'list') return supervisor.json('/auth/mcp')
      if (mutationBusy) throw new Error(t('lifecycleBusy'))
      mutationBusy = true
      try { return await supervisor.json('/auth/mcp', value) } finally { mutationBusy = false }
    }
    if (operation === 'list') return plugins.mcpList()
    if (operation !== 'save') throw new Error('Unknown MCP operation')
    if (mutationBusy || supervisor.busy) throw new Error(t('lifecycleBusy'))
    mutationBusy = true
    try { return await plugins.saveMcp(value) } finally { mutationBusy = false }
  })
  ipcMain.handle('edmore:skills', async (event, operation, value) => {
    assertSender(event)
    localOnly()
    const skills = new SkillManager(supervisor.config)
    if (operation === 'list') return skills.list()
    if (operation === 'tools') return skills.tools()
    if (operation === 'parse-support') return skills.parseSupport(value)
    if (operation !== 'save') throw new Error('Unknown skill operation')
    if (mutationBusy) throw new Error(t('pluginBusy'))
    mutationBusy = true
    try { return await skills.save(value) } finally { mutationBusy = false }
  })
  ipcMain.handle('edmore:configure', async (event, value) => {
    assertSender(event)
    if (supervisor.child || supervisor.busy || demo.child || weknora.child || weknora.busy || plugins.busy || mutationBusy) throw new Error(t('stopFirst'))
    mutationBusy = true
    try {
      if (!value || !['local', 'remote'].includes(value.mode ?? 'local')) throw new Error(t('required'))
      if (!['root', 'node', 'profile', 'baseUrl'].every(key => typeof value[key] === 'string')) throw new Error(t('required'))
      const url = new URL(value.baseUrl)
      if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error(t('loopbackOnly'))
      if (value.mode !== 'remote' && !isClientRoot(value.root)) throw new Error(t('missingRoot'))
      if (value.profile !== 'edmore-client') throw new Error('Only the edmore-client profile is supported')
      const next = Object.fromEntries(['root', 'node', 'profile', 'baseUrl'].map(key => [key, value[key].trim()]))
      next.baseUrl = url.origin
      next.mode = value.mode ?? 'local'
      next.remoteUrl = value.remoteUrl?.trim() ? remoteOrigin(value.remoteUrl.trim()) : ''
      if (next.mode === 'remote' && !next.remoteUrl) throw new Error(t('required'))
      await sharing.stop()
      await writeFile(configPath, JSON.stringify(next, null, 2))
      if (workspace && !workspace.isDestroyed()) workspace.close()
      if (remote()) await supervisor.stop()
      supervisor.removeAllListeners()
      supervisor = createConnection(next)
      weknora.removeAllListeners()
      weknora = new WeKnora(next.root,{node:next.node})
      supervisor.extraEnv = featureEnabled('wiki') ? await weknora.environment() : {}
      weknora.on('state', () => publish(supervisor.state))
      await weknora.refresh()
      plugins = new PluginManager(next, dataDir)
      await supervisor.refresh()
      publish(supervisor.state)
      return next
    } finally { mutationBusy = false }
  })
  // A small raster template icon works in both native tray implementations.
  const pixels = Buffer.alloc(16 * 16 * 4)
  for (let y = 3; y < 13; y++) for (let x = 3; x < 13; x++) {
    if (x < 5 || y < 5 || y > 10 || (y >= 7 && y <= 8 && x < 11)) {
      const offset = (y * 16 + x) * 4
      pixels[offset + 3] = 255
      if (process.platform !== 'darwin') { pixels[offset] = 120; pixels[offset + 1] = 180; pixels[offset + 2] = 40 }
    }
  }
  const icon = nativeImage.createFromBitmap(pixels, { width: 16, height: 16, scaleFactor: 1 })
  icon.setTemplateImage(process.platform === 'darwin')
  tray = new Tray(icon)
  tray.on('double-click', () => showPanel())
  applicationMenu()
  showPanel()
  await action('refresh')
  await demo.refreshExternal(supervisor.config.root)
  let ticks = 0
  timer = setInterval(() => {
    void (async () => {
      await supervisor.refresh()
      if (sharing.server && supervisor.state.username !== sharing.username) { await sharing.close(); publish(supervisor.state) }
      if (++ticks % 6 === 0 && ['running', 'external'].includes(supervisor.state.phase)) await supervisor.probeMcp()
      await weknora.refresh()
      await demo.refreshExternal(supervisor.config.root)
    })()
  }, 5000)
  app.on('activate', () => showPanel())
}

app.on('window-all-closed', () => { /* The tray owns the desktop lifetime. */ })
app.on('before-quit', event => {
  if (quitting) return
  event.preventDefault()
  if (quittingTask) return
  if (supervisor?.busy || plugins?.busy || mutationBusy) { showPanel(); supervisor?.publish({ error: t('waitQuit') }); return }
  quittingTask = (async () => {
    try {
      try { await sharing.stop() } catch { await sharing.close() }
      await supervisor?.stop()
      await demo?.stop()
      if (weknora?.child) await weknora.stop()
      clearInterval(timer)
      quitting = true
      app.quit()
    } catch (error) { showPanel(); dialog.showErrorBox(t('notStopped'), error.message) }
    finally { quittingTask = undefined }
  })()
})
if (!app.requestSingleInstanceLock()) { quitting = true; app.quit() }
else {
  app.on('second-instance', () => showPanel())
  void app.whenReady().then(main).catch(error => { dialog.showErrorBox('EDMORE', error.message); quitting = true; app.quit() })
}
