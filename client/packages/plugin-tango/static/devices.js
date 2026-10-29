const $ = id => document.getElementById(id)
const element = (tag, text) => { const el = document.createElement(tag); if (text) el.textContent = text; return el }
const status = message => { $('status').textContent = message }
let busy = false
async function request(input) {
  const response = await fetch('/auth/tango/devices', input ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) } : {})
  const result = await response.json()
  if (!response.ok) throw new Error(result.error || 'Device request failed')
  return result
}
async function action(input) {
  if (busy) return
  busy = true
  document.querySelectorAll('button').forEach(b => { b.disabled = true })
  try {
    const result = await request(input)
    await load()
    status(result.error ? `Ownership saved; registration needs attention: ${result.error}` :
      ['block', 'revoke-share'].includes(input.action) ? 'New calls blocked. An in-flight operation may still be running.' : 'Saved.')
    if (!result.error && ['claim', 'activate'].includes(input.action)) {
      await refreshTools('Connection saved. ')
    }
  } catch (error) { status(error.message) }
  finally { busy = false; document.querySelectorAll('button').forEach(b => { b.disabled = false }) }
}
function button(parent, label, input) {
  const b = element('button', label); b.type = 'button'; b.onclick = () => action(input); parent.append(b)
}
function targetForm(parent, device, operation) {
  const form = element('form'), label = element('label', 'Harness username'), input = element('input')
  input.name = 'username'; input.required = true; input.maxLength = 32; label.append(input); form.append(label)
  const select = element('select')
  if (operation === 'share') {
    for (const [value, text] of [['read', 'Read only'], ['operate', 'Operate']]) { const o = element('option', text); o.value = value; select.append(o) }
    const permissionLabel = element('label', 'Permission'); permissionLabel.append(select); form.append(permissionLabel)
  }
  const submit = element('button', { share: 'Request sharing approval', assign: 'Assign owner', 'revoke-share': 'Revoke sharing' }[operation])
  form.append(submit); form.onsubmit = e => { e.preventDefault(); action({ action: operation, device, username: input.value.trim(), permission: select.value }) }; parent.append(form)
}
async function load() {
  const state = await request()
  for (const id of ['mine', 'shared', 'requests', 'inventory']) $(id).replaceChildren()
  $('admin').hidden = !state.admin
  for (const row of state.devices) {
    const area = element('section'); area.append(element('h3', row.device), element('p', row.unclaimed ? 'Unclaimed' : `${row.registered ? 'Registered' : 'Pending registration'} | ${row.blocked ? 'Blocked' : row.permission || 'Management only'} | Owner: ${row.owner_label || row.owner}`))
    const parent = row.mine ? $('mine') : row.permission ? $('shared') : $('inventory')
    if (row.mine) {
      targetForm(area, row.device, 'share'); targetForm(area, row.device, 'revoke-share')
      if (!row.registered) button(area, 'Retry registration', { action: 'activate', device: row.device })
    }
    if (!row.unclaimed && (row.mine || state.admin)) button(area, row.blocked ? 'Allow new calls' : 'Block new calls', { action: row.blocked ? 'unblock' : 'block', device: row.device })
    if (row.unclaimed && state.admin) targetForm(area, row.device, 'assign')
    parent.append(area)
  }
  for (const row of state.shares) {
    const line = element('p', `${row.device} | ${row.permission} | ${row.status} | ${row.target_label || row.target}`)
    if (state.admin && row.status === 'pending') button(line, 'Approve sharing', { action: 'approve-share', device: row.device, request: row.id })
    $('requests').append(line)
  }
  for (const id of ['mine', 'shared', 'requests', 'inventory']) if (!$(id).children.length) $(id).append(element('p', 'None'))
  return state
}
async function refreshTools(prefix = '') {
  try {
    status(prefix + 'Refreshing Harness tools…')
    const response = await fetch('/auth/tango/refresh', { method: 'POST' })
    const result = await response.json()
    if (!response.ok) {
      if (response.status === 409) {
        status(prefix + 'A conversation is busy. Finish or cancel the current operation, then click Refresh Harness tools. Your device connection is saved.')
      } else {
        status(prefix + 'Tool refresh failed: ' + (result.error || 'Refresh unavailable') + '. Click Refresh Harness tools to retry; do not pair again.')
      }
      return false
    }
    status(prefix + 'Harness tools refreshed. Return to your conversation and select the device.')
    return true
  } catch (error) {
    status(prefix + 'Tool refresh failed: ' + error.message + '. Click Refresh Harness tools to retry; do not pair again.')
    return false
  }
}
$('pair').onsubmit = event => { event.preventDefault(); action({ action: 'claim', code: new FormData(event.target).get('code').trim() }) }
$('refresh').onclick = async () => {
  if (busy) return
  busy = true; $('refresh').disabled = true
  try {
    await refreshTools()
  } catch (error) { status(error.message) }
  finally { busy = false; $('refresh').disabled = false }
}
async function initialize() {
  busy = true
  document.querySelectorAll('button').forEach(b => { b.disabled = true })
  try {
    const state = await load()
    // Recover an already paired user's stale runtime without submitting another claim.
    if (state.devices.some(row => row.registered && !row.blocked && row.permission)) await refreshTools()
  } catch (error) { status(error.message) }
  finally { busy = false; document.querySelectorAll('button').forEach(b => { b.disabled = false }) }
}
initialize()
