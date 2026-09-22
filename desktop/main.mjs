import { app, BrowserWindow, Menu, Tray, nativeImage, ipcMain, dialog } from 'electron'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Supervisor } from './supervisor.mjs'
import { PluginManager } from './plugins.mjs'
import { SkillManager } from './skills.mjs'
import { messages } from './locale.mjs'
import { trayTemplate } from './menus.mjs'
import { loadDesktopConfig, isClientRoot } from './config.mjs'

const here = dirname(fileURLToPath(import.meta.url))
app.setName('EDMORE')
if (!app.isPackaged && process.env.EDMORE_DESKTOP_TEST_DATA_DIR) app.setPath('userData', process.env.EDMORE_DESKTOP_TEST_DATA_DIR)
let panel, workspace, tray, supervisor, plugins, quitting = false, timer, quittingTask
let language = 'en', preferencesPath, mutationBusy = false
const panelUrl = pathToFileURL(join(here, 'renderer/index.html')).href
const t = key => messages(language)[key] ?? key

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

async function openWorkspace() {
  if (!['running', 'external'].includes(supervisor.state.phase)) throw new Error(t('notReady'))
  if (process.platform === 'darwin') void app.dock.show()
  if (workspace && !workspace.isDestroyed()) { workspace.show(); workspace.focus(); return }
  workspace = new BrowserWindow({ width: 1400, height: 920, title: 'EDMORE Workspace',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } })
  workspace.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  workspace.webContents.on('will-navigate', (event, url) => {
    if (new URL(url).origin !== new URL(supervisor.config.baseUrl).origin) event.preventDefault()
  })
  await workspace.loadURL(`${supervisor.config.baseUrl}/edmore`)
}

function publish(state) {
  if (panel && !panel.isDestroyed()) panel.webContents.send('edmore:state', state)
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
    if (['start', 'stop', 'restart'].includes(name)) {
      if (mutationBusy) throw new Error(t('pluginBusy'))
      mutationBusy = true; acquired = true
    }
    if (plugins.busy && ['start', 'stop', 'restart'].includes(name)) throw new Error(t('pluginBusy'))
    if (name === 'background') background()
    else if (name === 'open') await openWorkspace()
    else {
      if (name === 'start' || name === 'restart') supervisor.config.pluginPatch = await plugins.writePatch()
      if (name === 'stop' || name === 'restart') {
        if (workspace && !workspace.isDestroyed()) workspace.close()
      }
      await supervisor[name]()
      await supervisor.refresh()
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
  supervisor = new Supervisor(config)
  plugins = new PluginManager(config, dataDir)
  supervisor.on('state', publish)
  const assertSender = event => {
    if (event.senderFrame !== panel?.webContents.mainFrame || event.senderFrame.url !== panelUrl) throw new Error('Untrusted desktop IPC sender')
  }
  ipcMain.handle('edmore:read', event => { assertSender(event); return { config: supervisor.config, state: supervisor.state, language } })
  ipcMain.handle('edmore:language', (event, id) => { assertSender(event); return changeLanguage(id) })
  ipcMain.handle('edmore:action', (event, name) => {
    assertSender(event)
    if (!['start', 'stop', 'restart', 'refresh', 'probeMcp', 'open', 'background'].includes(name)) throw new Error('Unknown action')
    return action(name)
  })
  ipcMain.handle('edmore:plugins', async (event, operation, value) => {
    assertSender(event)
    if (operation === 'list') return plugins.list()
    if (operation === 'previewToggle') return plugins.previewToggle(value?.id, value?.enabled)
    if (mutationBusy) throw new Error(t('pluginBusy'))
    mutationBusy = true
    try {
      if (supervisor.busy) throw new Error(t('lifecycleBusy'))
      if (operation === 'toggle') return await plugins.toggle(value?.id, value?.enabled, value?.changes)
      if (!['install', 'remove'].includes(operation)) throw new Error('Unknown plugin operation')
      await supervisor.refresh()
      if (supervisor.child || supervisor.busy || !['stopped', 'error'].includes(supervisor.state.phase)) throw new Error(t('packageStopped'))
      return operation === 'install' ? await plugins.install(value?.spec, value?.config) : await plugins.remove(value?.id)
    } catch (error) { throw new Error(t(error.message)) }
    finally { mutationBusy = false }
  })
  ipcMain.handle('edmore:skills', async (event, operation, value) => {
    assertSender(event)
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
    if (supervisor.child || supervisor.busy || plugins.busy || mutationBusy) throw new Error(t('stopFirst'))
    mutationBusy = true
    try {
      if (!value || !['root', 'node', 'profile', 'baseUrl'].every(key => typeof value[key] === 'string' && value[key].trim())) throw new Error(t('required'))
      const url = new URL(value.baseUrl)
      if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error(t('loopbackOnly'))
      if (!isClientRoot(value.root)) throw new Error(t('missingRoot'))
      if (value.profile !== 'edmore-client') throw new Error('Only the edmore-client profile is supported')
      const next = Object.fromEntries(['root', 'node', 'profile', 'baseUrl'].map(key => [key, value[key].trim()]))
      next.baseUrl = url.origin
      await writeFile(configPath, JSON.stringify(next, null, 2))
      supervisor.config = next
      plugins = new PluginManager(next, dataDir)
      await supervisor.refresh()
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
  let ticks = 0
  timer = setInterval(() => {
    void (async () => {
      await supervisor.refresh()
      if (++ticks % 6 === 0 && ['running', 'external'].includes(supervisor.state.phase)) await supervisor.probeMcp()
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
      await supervisor?.stop()
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
