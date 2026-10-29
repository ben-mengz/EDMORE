const $ = selector => document.querySelector(selector)
let settings, skills = [], selectedSkill, selectedMcp
const categoryOf = row => row.category || (row.kind === 'knowledge' ? 'support' : 'workflow')
const entryName = row => categoryOf(row) === 'workflow' ? 'Workflow' : 'Skill'
const compound = row => row?.kind === 'compound_workflow' || Boolean(row?.references?.length)
const notice = (message, error = false) => { $('#status').textContent = message; $('#status').dataset.error = String(error) }
async function api(path, value) {
  const response = await fetch(`/api/admin/${path}`, { method: value === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json' }, ...(value === undefined ? {} : { body: JSON.stringify(value) }) })
  if (response.status === 401) { location.assign('/login'); throw new Error('Sign in required') }
  const data = await response.json()
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`)
  return data
}
async function run(button, action) {
  button.disabled = true; notice('')
  try { await action() } catch (error) { notice(error.message, true) }
  finally { button.disabled = false }
}
document.querySelectorAll('[data-tab]').forEach(button => button.onclick = () => {
  document.querySelectorAll('[data-tab]').forEach(b => b.setAttribute('aria-selected', String(b === button)))
  document.querySelectorAll('.tab').forEach(section => section.hidden = section.id !== button.dataset.tab)
})
function item(target, title, subtitle, selected, action) {
  const button = document.createElement('button'); button.type = 'button'; button.textContent = title
  button.setAttribute('aria-current', String(selected))
  const small = document.createElement('small'); small.textContent = subtitle; button.append(small)
  button.onclick = action; target.append(button)
}
async function refresh() {
  const [data, listing] = await Promise.all([api('settings'), api('skills')])
  settings = data.settings; skills = listing.rows
  $('#revision').textContent = `Revision ${settings.revision}`
  $('#runtime-rows').replaceChildren()
  for (const worker of data.workers) {
    const row = document.createElement('tr')
    for (const text of [worker.username, worker.status, worker.revision === settings.revision ? `Current (${worker.revision})` : `Pending (${worker.revision ?? '-'})`]) { const cell = document.createElement('td'); cell.textContent = text; row.append(cell) }
    const actions = document.createElement('td')
    const restart = document.createElement('button'); restart.type = 'button'; restart.textContent = 'Restart'
    restart.onclick = () => { if (confirm(`Restart ${worker.username}'s runtime? Active conversations will block the restart.`)) void run(restart, async () => { await api('workers/restart', { username: worker.username }); await refresh(); notice(`${worker.username}'s runtime restarted and reconnected.`) }) }
    actions.append(restart); row.append(actions)
    $('#runtime-rows').append(row)
  }
  if (!data.workers.length) { const row = document.createElement('tr'); const cell = document.createElement('td'); cell.colSpan = 4; cell.textContent = 'No active runtimes'; row.append(cell); $('#runtime-rows').append(row) }
  renderSkills(); renderMcp(); renderPlugins()
  if (!selectedSkill) { const first = skills.find(row => categoryOf(row) === $('#catalog-category').value); if (first) editSkill(first) }
}
function renderSkills() {
  $('#skill-list').replaceChildren()
  const category = $('#catalog-category').value
  const visible = skills.filter(row => categoryOf(row) === category)
  $('#skill-list').ariaLabel = category === 'workflow' ? 'Workflows' : 'Skills'
  for (const row of visible) item($('#skill-list'), row.name || row.id, `${compound(row) ? 'Compound workflow' : entryName(row)} / ${row.source}`, selectedSkill?.id === row.id, () => editSkill(row))
  if (!visible.length) $('#skill-list').textContent = category === 'workflow' ? 'No workflows' : 'No skills'
}
const sf = $('#skill-form')
$('#catalog-category').onchange = () => { selectedSkill = null; sf.hidden = true; renderSkills() }
function renderWorkflowFields(row) {
  const isWorkflow = sf.elements.category.value === 'workflow'
  $('#steps-label').hidden = !isWorkflow || compound(row)
  $('#workflow-children').hidden = !isWorkflow || !compound(row)
  $('#workflow-child-list').replaceChildren()
  for (const id of row.references || []) {
    const child = skills.find(entry => entry.id === id)
    const li = document.createElement('li')
    if (child) { const button = document.createElement('button'); button.type = 'button'; button.textContent = child.name || id; button.onclick = () => editSkill(child); li.append(button) }
    else li.textContent = `${id} (unavailable)`
    $('#workflow-child-list').append(li)
  }
  sf.querySelector('button[type=submit]').textContent = isWorkflow ? 'Save workflow' : 'Save skill'
}
function editSkill(row) {
  selectedSkill = row; sf.hidden = false
  $('#catalog-category').value = categoryOf(row)
  for (const name of ['id','name','description','category']) sf.elements[name].value = row[name] || (name === 'category' ? 'support' : '')
  sf.elements.content.value = row.content || row.inherited_instructions || row.instructions || ''
  sf.elements.steps.value = JSON.stringify(row.steps || [], null, 2)
  const builtin = row.source === 'builtin'
  sf.querySelectorAll('input,select,textarea,button[type=submit]').forEach(node => node.disabled = builtin || compound(row))
  $('#skill-heading').textContent = `${builtin ? 'Built-in' : 'Custom'} ${entryName(row).toLowerCase()}`
  $('#duplicate-skill').disabled = compound(row)
  $('#duplicate-skill').title = compound(row) ? 'Compound workflow duplication is not supported' : ''
  $('#remove-skill').hidden = !row.source || builtin
  renderWorkflowFields(row)
  renderSkills()
}
$('#new-skill').onclick = () => editSkill({ category: 'support' })
$('#new-workflow').onclick = () => editSkill({ category: 'workflow' })
$('#import-skill').onclick = () => $('#skill-file').click()
$('#skill-file').onchange = async event => {
  const file = event.target.files[0]
  if (!file) return
  await run($('#import-skill'), async () => {
    if (file.size > 200000) throw new Error('SKILL.md is too large')
    editSkill(await api('skills/parse', { instructions: await file.text() }))
  })
  event.target.value = ''
}
sf.elements.category.onchange = () => { renderWorkflowFields(selectedSkill); $('#skill-heading').textContent = `Custom ${sf.elements.category.value === 'workflow' ? 'workflow' : 'skill'}` }
$('#duplicate-skill').onclick = () => editSkill({ ...selectedSkill, source: undefined, id: '', name: `${sf.elements.name.value} copy` })
sf.onsubmit = event => { event.preventDefault(); void run(sf.querySelector('button[type=submit]'), async () => {
  const value = Object.fromEntries(new FormData(sf))
  if (value.category === 'workflow') { value.steps = JSON.parse(value.steps); value.instructions = value.content }
  else { delete value.steps; if (selectedSkill?.category === 'support') value.instructions = selectedSkill.instructions }
  const saved = await api('skills', value); await refresh(); editSkill(saved); notice(`${entryName(saved)} saved. Configuration pending apply.`)
}) }
$('#remove-skill').onclick = event => { if (confirm(`Remove ${entryName(selectedSkill).toLowerCase()} ${selectedSkill.id}?`)) void run(event.currentTarget, async () => { const label = entryName(selectedSkill); await api('skills', { id: selectedSkill.id, remove: true }); selectedSkill = null; sf.hidden = true; await refresh(); notice(`${label} removed. Configuration pending apply.`) }) }
function renderMcp() {
  $('#mcp-list').replaceChildren()
  for (const row of settings.mcp) item($('#mcp-list'), row.id, `${row.scope === 'shared' ? 'All users' : 'Administrators'} / ${row.kind === 'edmore' ? 'EDMORE' : row.transport} / ${row.enabled ? 'Enabled' : 'Disabled'}`, selectedMcp?.id === row.id, () => editMcp(row))
  if (!settings.mcp.length) $('#mcp-list').textContent = 'No connections'
}
const mf = $('#mcp-form')
function transport() {
  const http = mf.elements.transport.value === 'streamable-http'
  $('#url-label').hidden = !http; $('#command-label').hidden = http; $('#args-label').hidden = http
  mf.elements.url.required = http; mf.elements.command.required = !http
  $('#secrets-label').textContent = http ? 'Headers (JSON)' : 'Environment (JSON)'
}
function editMcp(row) {
  selectedMcp = row; mf.hidden = false; mf.reset()
  mf.elements.kind.value = row.kind || 'standard'; mf.elements.scope.value = row.scope || 'administrators'
  mf.elements.kind.disabled = Boolean(row.id)
  mf.elements.transport.disabled = row.kind === 'edmore'
  for (const name of ['id','url','command','transport']) mf.elements[name].value = row[name] || (name === 'transport' ? 'streamable-http' : '')
  mf.elements.id.readOnly = Boolean(row.id)
  mf.elements.args.value = JSON.stringify(row.args || [], null, 2)
  mf.elements.enabled.checked = row.enabled ?? false
  $('#secret-state').textContent = row.secretConfigured ? 'Secrets configured. Blank keeps existing values; {} clears them.' : 'No secrets configured'
  $('#remove-mcp').hidden = !row.id
  transport(); renderMcp()
}
mf.elements.transport.onchange = transport
mf.elements.kind.onchange = () => {
  const edmore = mf.elements.kind.value === 'edmore'
  mf.elements.id.value = edmore ? 'nionswift' : ''; mf.elements.id.readOnly = edmore
  mf.elements.transport.value = 'streamable-http'; mf.elements.transport.disabled = edmore
  transport()
}
$('#new-mcp').onclick = () => editMcp({})
$('#inspect-mcp').onclick = event => void run(event.currentTarget, async () => {
  const data = await api('connections')
  const counts = settings.mcp.map(row => `${row.id}: ${data.tools.filter(t => t.name.startsWith(`mcp__${row.id}__`)).length} tools`)
  $('#connection-status').textContent = `Runtime revision ${data.revision}. ${counts.join('; ') || 'No connections configured.'}`
})
mf.onsubmit = event => { event.preventDefault(); void run(mf.querySelector('button[type=submit]'), async () => {
  const value = Object.fromEntries(new FormData(mf)); value.enabled = mf.elements.enabled.checked
  value.kind = mf.elements.kind.value; value.transport = mf.elements.transport.value
  value.args = value.transport === 'stdio' ? JSON.parse(value.args) : []
  if (value.secrets.trim()) value.secrets = JSON.parse(value.secrets); else delete value.secrets
  await api('mcp', value); await refresh(); editMcp(settings.mcp.find(row => row.id === value.id)); notice('Connection saved. Configuration pending apply.')
}) }
$('#remove-mcp').onclick = event => { if (confirm(`Remove connection ${selectedMcp.id}?`)) void run(event.currentTarget, async () => { await api('mcp', { id: selectedMcp.id, remove: true }); selectedMcp = null; mf.hidden = true; await refresh(); notice('Connection removed. Configuration pending apply.') }) }
function renderPlugins() {
  $('#plugin-list').replaceChildren()
  for (const [id, label, scope] of [['edmore-model-hu','HU models','Personal switch available'],['edmore-model-bonsai','Bonsai model','Personal switch available'],['edmore-model-strata','Strata model','Personal switch available'],['edmore-tango','Tango instruments','Authorized devices only'],['edmore-plan-judge','Workflow Engine','All users; personal switch available'],['edmore-conversation-title','Conversation titles','All users; personal switch available'],['edmore-wiki','Wiki memory (GPT)','Per-user opt-in; scoped knowledge bases'],['edmore-jev-decisions','Jev decisions','All users; shared key; requires Workflow Engine']]) {
    const row = document.createElement('div'); row.className = 'plugin-row'
    const text = document.createElement('div'); const name = document.createElement('strong'); name.textContent = label; const detail = document.createElement('small'); detail.textContent = scope; text.append(name,detail)
    const control = document.createElement('label'); control.className = 'check'
    const input = document.createElement('input'); input.type = 'checkbox'; input.checked = settings.plugins[id]; input.setAttribute('aria-label', label)
    input.onchange = () => void run(input, async () => { try { await api('plugins',{ id, enabled: input.checked }); await refresh(); notice('Plugin saved. Configuration pending apply.') } catch(error) { input.checked = !input.checked; throw error } })
    control.append(input, document.createTextNode('Enabled')); row.append(text,control); $('#plugin-list').append(row)
  }
  $('#jev-key-state').textContent = settings.jevKeyConfigured ? 'Key configured' : 'No key configured'
}
$('#jev-key-form').onsubmit = event => { event.preventDefault(); void run(event.currentTarget.querySelector('button'), async () => { const apiKey = $('#jev-key-form').elements.apiKey.value.trim(); if (!apiKey) throw new Error('Enter an API key'); await api('plugins',{ id:'edmore-jev-decisions', enabled:settings.plugins['edmore-jev-decisions'], apiKey }); $('#jev-key-form').reset(); await refresh(); notice('Key saved. Configuration pending apply.') }) }
$('#clear-jev-key').onclick = event => { if (confirm('Clear the Jev API key and disable Jev?')) void run(event.currentTarget, async () => { await api('plugins',{id:'edmore-jev-decisions',enabled:false,clearKey:true}); await refresh(); notice('Key cleared. Configuration pending apply.') }) }
$('#reload').onclick = event => void run(event.currentTarget, refresh)
$('#apply').onclick = event => { if (confirm('Apply server settings and reconnect idle user runtimes? Active conversations will prevent this operation.')) void run(event.currentTarget, async () => { await api('apply',{}); await refresh(); notice('Settings applied. Runtimes start on the next workspace request.') }) }
refresh().catch(error => notice(error.message,true))
