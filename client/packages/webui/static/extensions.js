export function conversationExtensions(slot, api, currentSession) {
  const mounted = new Map()
  let loading
  let requested = false
  async function refresh() {
    requested = true
    if (loading) return loading
    loading = (async () => {
      do {
      requested = false
      const session = currentSession()
      const { extensions } = await api('/api/edmore/extensions')
      const ids = new Set(extensions.map(item => item.id))
      for (const [id, entry] of mounted) if (!ids.has(id)) { entry.panel.dispose?.(); entry.root.remove(); mounted.delete(id) }
      await Promise.all(extensions.map(async item => {
        if (!/^[a-z][a-z0-9-]*$/.test(item.id) || item.module !== `/api/edmore/extensions/${item.id}/panel.js`) return
        let entry = mounted.get(item.id)
        if (!entry) {
          const root = document.createElement('section'); root.className = 'rail-section'; root.hidden = true
          try {
            const module = await import(item.module)
            const panel = module.mount(root, { api, currentSession })
            entry = { root, panel }; mounted.set(item.id, entry); slot.append(root)
          } catch { root.remove(); return }
        }
        await entry.panel.refresh().catch(() => {})
      }))
      slot.hidden = mounted.size === 0
      if (session !== currentSession()) requested = true
      } while (requested)
    })().catch(() => {}).finally(() => { loading = undefined })
    return loading
  }
  return { refresh }
}
