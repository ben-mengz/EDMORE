const { contextBridge, ipcRenderer } = require('electron')
contextBridge.exposeInMainWorld('edmore', {
  read: () => ipcRenderer.invoke('edmore:read'),
  action: name => ipcRenderer.invoke('edmore:action', name),
  configure: value => ipcRenderer.invoke('edmore:configure', value),
  language: value => ipcRenderer.invoke('edmore:language', value),
  plugins: (operation, value) => ipcRenderer.invoke('edmore:plugins', operation, value),
  onLanguage: listener => {
    const handler = (_event, value) => listener(value)
    ipcRenderer.on('edmore:language', handler)
    return () => ipcRenderer.removeListener('edmore:language', handler)
  },
  onTab: listener => {
    const handler = (_event, value) => listener(value)
    ipcRenderer.on('edmore:tab', handler)
    return () => ipcRenderer.removeListener('edmore:tab', handler)
  },
  subscribe: listener => {
    const handler = (_event, state) => listener(state)
    ipcRenderer.on('edmore:state', handler)
    return () => ipcRenderer.removeListener('edmore:state', handler)
  },
})
