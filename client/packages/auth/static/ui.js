const status = document.querySelector('#status')
async function api(path, payload) {
  const response = await fetch(path, { method: payload ? 'POST' : 'GET', headers: { 'content-type': 'application/json' }, ...(payload ? { body: JSON.stringify(payload) } : {}) })
  const data = await response.json()
  if (!response.ok) { if (response.status === 401 && !document.querySelector('#login')) location.assign('/login'); throw new Error(data.error || `HTTP ${response.status}`) }
  return data
}
function form(id, action) {
  const element = document.querySelector(id)
  if (!element) return
  element.onsubmit = async event => {
    event.preventDefault(); status.textContent = ''
    const button = element.querySelector('button'); button.disabled = true
    try { await action(Object.fromEntries(new FormData(element)), element) }
    catch (error) { status.textContent = error.message }
    finally { button.disabled = false }
  }
}
function clearLocalIdentity() {
  for (const storage of [localStorage, sessionStorage]) for (const key of Object.keys(storage)) if (key.startsWith('edmore-')) storage.removeItem(key)
}
form('#login', async input => { await api('/auth/login', input); clearLocalIdentity(); location.assign('/edmore/') })
form('#password', async input => { await api('/auth/password', input); clearLocalIdentity(); location.assign('/login') })
form('#jev-key', async (input, element) => {
  await api('/auth/jev', input); element.reset()
  document.querySelector('#jev-state').textContent = 'Key configured'
  document.querySelector('#clear-jev').disabled = false
  status.textContent = 'TypeSafe API key saved; your Harness will restart on the next request'
})
form('#create-user', async (input, element) => { await api('/auth/users', { ...input, isAdmin: input.isAdmin === 'on', action: 'create' }); element.reset(); await loadUsers(); status.textContent = 'User created' })
async function loadUsers() {
  const { users } = await api('/auth/users')
  const target = document.querySelector('#users'); target.replaceChildren()
  for (const user of users) {
    const row = document.createElement('tr')
    for (const value of [user.username, user.isAdmin ? 'Administrator' : 'User', user.disabled ? 'Disabled' : 'Active', user.sessions]) { const cell = document.createElement('td'); cell.textContent = value; row.append(cell) }
    const actions = document.createElement('td')
    for (const [label, action] of [[user.disabled ? 'Enable' : 'Disable', 'set-disabled'], ['Reset password', 'reset-password']]) {
      const button = document.createElement('button'); button.textContent = label
      button.onclick = async () => {
        status.textContent = ''; button.disabled = true
        try {
          const payload = { action, username: user.username, disabled: !user.disabled }
          if (action === 'reset-password') { payload.password = prompt('New password (at least 12 characters)'); if (!payload.password) return }
          await api('/auth/users', payload); await loadUsers()
        } catch (error) { status.textContent = error.message } finally { button.disabled = false }
      }
      actions.append(button)
    }
    row.append(actions); target.append(row)
  }
}
if (document.querySelector('#account')) {
  const mcpSection = document.createElement('section'); mcpSection.id = 'personal-mcp'
  document.querySelector('#account').insertBefore(mcpSection, document.querySelector('#account > section'))
  import('/auth/mcp-editor.js').then(({ mcpEditor }) => mcpEditor(mcpSection, {
    list: () => api('/auth/mcp'), save: value => api('/auth/mcp', value), cloud: true,
  }).open()).catch(error => { status.textContent = error.message })
  document.querySelector('#logout').onclick = async () => { try { await api('/auth/logout', {}); clearLocalIdentity(); location.assign('/login') } catch (error) { status.textContent = error.message } }
  api('/auth/me').then(async me => {
    document.querySelector('#identity').textContent = me.username
    if (me.devices?.available) {
      const link = document.createElement('a'); link.href = '/devices'; link.textContent = 'Devices'
      document.querySelector('header').append(link)
    }
    if(me.wiki?.browser) {
      const wikiLink=document.createElement('a')
      wikiLink.href='/auth/wiki/open';wikiLink.target='_blank';wikiLink.rel='noopener';wikiLink.textContent='Open My Wiki'
      document.querySelector('header').append(wikiLink)
    }
    document.querySelector('#admin').hidden = !me.isAdmin
    document.querySelector('#jev').hidden = !me.jev.required
    if (me.jev.required) {
      const state = document.querySelector('#jev-state')
      state.textContent = me.jev.configured ? 'Key configured' : 'Key not configured; Jev will fall back to the LLM'
      document.querySelector('#clear-jev').disabled = !me.jev.configured
      document.querySelector('#clear-jev').onclick = async event => {
        event.currentTarget.disabled = true; status.textContent = ''
        try {
          await api('/auth/jev', { clear: true })
          state.textContent = 'Key not configured; Jev will fall back to the LLM'
          status.textContent = 'TypeSafe API key removed'
        } catch (error) { status.textContent = error.message; event.currentTarget.disabled = false }
      }
    }
    if (me.isAdmin) {
      const link = document.createElement('a')
      link.href = '/admin'; link.textContent = 'Server settings'
      document.querySelector('header').append(link)
    }
    for (const plugin of me.plugins) {
      const label = document.createElement('label'); label.className = 'check'
      const input = document.createElement('input'); input.type = 'checkbox'; input.checked = plugin.enabled; input.disabled = plugin.allowed === false
      input.onchange = async () => {
        input.disabled = true
        try { await api('/auth/plugins', { id: plugin.id, enabled: input.checked }); status.textContent = 'Plugin settings saved' }
        catch (error) { input.checked = !input.checked; status.textContent = error.message }
        finally { input.disabled = false }
      }
      label.append(input, document.createTextNode(plugin.name)); document.querySelector('#plugins').append(label)
    }
    if (me.isAdmin) await loadUsers()
  }).catch(error => { status.textContent = error.message })
}
