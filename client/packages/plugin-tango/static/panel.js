export function mount(root, { api, currentSession }) {
  const css = document.createElement('link')
  css.rel = 'stylesheet'; css.href = '/api/edmore/extensions/tango/panel.css'
  root.id = 'conversationInstruments'
  root.setAttribute('aria-label', 'Conversation instruments')
  root.innerHTML = '<div class="panel-header"><h2>Instruments</h2><button type="button" title="Refresh instruments" aria-label="Refresh instruments">&#8635;</button></div><div data-devices class="instrument-options"></div><p data-status role="status"></p>'
  root.prepend(css)
  let generation = 0
  const list = root.querySelector('[data-devices]')
  const status = root.querySelector('[data-status]')
  const refreshButton = root.querySelector('button')
  async function refresh() {
    const version = ++generation
    const session = currentSession()
    list.replaceChildren()
    status.textContent = 'Loading...'
    try {
      const data = await api(`/api/edmore/extensions/tango/state?session_id=${encodeURIComponent(session)}`)
      if (version !== generation || currentSession() !== session) return
      root.hidden = !data.enabled
      if (!data.enabled) return
      status.textContent = data.error || (data.locked ? 'Selection locked during workflow or response' : data.devices.length ? '' : 'No authorized instruments')
      const visible = new Map(data.devices.map(item => [item.device, item]))
      for (const device of data.selected) if (!visible.has(device)) visible.set(device, { device, available: false })
      for (const item of visible.values()) {
        const label = document.createElement('label')
        const input = document.createElement('input')
        input.type = 'checkbox'
        input.value = item.device
        input.checked = data.selected.includes(item.device)
        input.disabled = Boolean(data.error || data.locked || (!item.available && !input.checked))
        const text = document.createElement('span')
        text.textContent = item.device + (item.available ? '' : ' (unavailable)')
        label.append(input, text)
        list.append(label)
        input.onchange = async () => {
          const devices = [...list.querySelectorAll('input:checked')].map(box => box.value)
          for (const box of list.querySelectorAll('input')) box.disabled = true
          status.textContent = 'Saving...'
          let failure
          try { await api('/api/edmore/extensions/tango/state', { method: 'POST', body: JSON.stringify({ session_id: session, devices }) }) }
          catch (error) { failure = error.message }
          if (currentSession() !== session || generation !== version) return
          await refresh()
          if (failure && currentSession() === session) status.textContent = failure
        }
      }
    } catch {
      if (version === generation) status.textContent = 'Cannot load instruments. Refresh to retry.'
    }
  }
  refreshButton.onclick = refresh
  return { refresh }
}
