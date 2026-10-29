import { conversationExtensions } from './extensions.js'

const extensions = conversationExtensions(document.querySelector('#conversationExtensions'), api, () => sessionId)
// randomUUID is unavailable on plain HTTP origins; getRandomValues still works.
function newId() {
  if (globalThis.crypto.randomUUID) return globalThis.crypto.randomUUID()
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6] & 15) | 64
  bytes[8] = (bytes[8] & 63) | 128
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

const settingsDialog = document.querySelector('#settingsDialog')
let authenticatedUser = false
fetch('/auth/me').then(async response => {
  if (response.status === 401) { location.assign('/login'); return }
  if (!response.ok) return
  const identity = await response.json()
  if (!identity.enabled) return
  authenticatedUser = true
  const previous = localStorage.getItem('edmore-auth-user')
  if (previous !== identity.username) {
    for (const storage of [localStorage, sessionStorage]) for (const key of Object.keys(storage)) if (key.startsWith('edmore-')) storage.removeItem(key)
    localStorage.setItem('edmore-auth-user', identity.username)
    location.reload(); return
  }
  const link = document.createElement('a')
  link.href = '/account'; link.textContent = identity.username + ' · Account'
  document.querySelector('#openSettings').after(link)
  document.querySelector('#newProvider').hidden = true
  fillProviderForm(selectedProvider())
}).catch(() => {})
const settingsContent = document.querySelector('#settingsContent')
const settingsNavigation = document.querySelector('#settingsNavigation')
const settingsPanels = [...document.querySelectorAll('.side-panel > .panel')].filter(panel => !panel.querySelector('#pending'))
const settingsLabels = ['Models', 'MCP', 'Tools', 'Agents', 'Workflows & Skills', 'Events']
settingsPanels.forEach((panel, index) => {
  panel.hidden = index !== 0
  settingsContent.append(panel)
  const button = document.createElement('button')
  button.type = 'button'
  button.textContent = settingsLabels[index]
  button.setAttribute('aria-pressed', String(index === 0))
  button.onclick = () => {
    settingsPanels.forEach((item, i) => { item.hidden = i !== index })
    ;[...settingsNavigation.children].forEach((item, i) => item.setAttribute('aria-pressed', String(i === index)))
  }
  settingsNavigation.append(button)
})
document.querySelector('#openSettings').onclick = () => settingsDialog.showModal()
document.querySelector('#closeSettings').onclick = () => settingsDialog.close()
const conversationModel = document.querySelector('#conversationModel')
let modelSelectionGeneration = 0
async function refreshConversationModel() {
  extensions.refresh().catch(() => {})
  const generation = ++modelSelectionGeneration
  const data = await api(`/api/edmore/conversation-model?session_id=${encodeURIComponent(sessionId)}`)
  if (generation !== modelSelectionGeneration) return
  conversationModel.replaceChildren(new Option(`Default${data.effective && !data.override ? ` · ${data.effective.model}` : ''}`, ''))
  for (const profile of providerProfiles) {
    const option = new Option(`${profile.displayName || profile.id} · ${profile.model}${profile.credential?.configured === false ? ' (key required)' : ''}`, JSON.stringify([profile.id, profile.model]))
    option.disabled = profile.credential?.configured === false
    conversationModel.add(option)
  }
  const value = data.override ? JSON.stringify([data.override.provider, data.override.model]) : ''
  if (value && ![...conversationModel.options].some(option => option.value === value)) conversationModel.add(new Option(`${data.override.provider} · ${data.override.model}`, value))
  conversationModel.value = value
}
conversationModel.onchange = async () => {
  const targetSession = sessionId
  const [provider, model] = conversationModel.value ? JSON.parse(conversationModel.value) : [null, null]
  conversationModel.disabled = true
  try {
    await api('/api/edmore/conversation-model', { method: 'POST', body: JSON.stringify({ session_id: targetSession, provider, model }) })
    document.querySelector('#modelStatus').textContent = 'Saved for this conversation'
  } catch (error) { document.querySelector('#modelStatus').textContent = error.message }
  finally { conversationModel.disabled = false; await refreshConversationModel().catch(() => {}) }
}
document.querySelector('#roleModelForm').onsubmit = async event => {
  event.preventDefault()
  const form = event.currentTarget
  const button = form.querySelector('button')
  button.disabled = true
  try {
    const [provider, model] = JSON.parse(document.querySelector('#roleModelSelect').value)
    await api('/api/edmore/agent-roles', { method: 'POST', body: JSON.stringify({ role: document.querySelector('#roleSelect').value, provider, model }) })
    document.querySelector('#roleModelStatus').textContent = 'Saved'
    await refreshAgentRolesRegistry()
    await refreshConversationModel()
  } catch (error) { document.querySelector('#roleModelStatus').textContent = error.message }
  finally { button.disabled = false }
}
document.querySelector('#resetRoleModel').onclick = async () => {
  try {
    await api('/api/edmore/agent-roles', { method: 'POST', body: JSON.stringify({ role: document.querySelector('#roleSelect').value, model: null, provider: null }) })
    document.querySelector('#roleModelStatus').textContent = 'Using inherited model'
    await refreshAgentRolesRegistry()
  } catch (error) { document.querySelector('#roleModelStatus').textContent = error.message }
}

const runtime = document.querySelector('#runtime')
const mcpStatus = document.querySelector('#mcpStatus')
const providerBadge = document.querySelector('#providerBadge')
const events = document.querySelector('#events')
const agents = document.querySelector('#agents')
const tools = document.querySelector('#tools')
const pending = document.querySelector('#pending')
const instrumentOccupancy = document.querySelector('#instrumentOccupancy')
const approve = document.querySelector('#approve')
const reject = document.querySelector('#reject')
const confirmWorkflow = document.querySelector('#confirmWorkflow')
const promptInput = document.querySelector('#prompt')
const stopGeneration = document.querySelector('#stopGeneration')
const cancelWorkflow = document.querySelector('#cancelWorkflow')
const chatHistory = document.querySelector('#chatHistory')
const processStatus = document.querySelector('#processStatus')
const providerSelect = document.querySelector('#providerSelect')
const providerId = document.querySelector('#providerId')
const providerName = document.querySelector('#providerName')
const providerBaseUrl = document.querySelector('#providerBaseUrl')
const providerModel = document.querySelector('#providerModel')
const providerEmbeddingModel = document.querySelector('#providerEmbeddingModel')
const providerApiKey = document.querySelector('#providerApiKey')
const providerStatus = document.querySelector('#providerStatus')
const selectProvider = document.querySelector('#selectProvider')
const loadProvider = document.querySelector('#loadProvider')
const newProvider = document.querySelector('#newProvider')
const harnessTools = document.querySelector('#harnessTools')
const refreshHarnessTools = document.querySelector('#refreshHarnessTools')
const agentRoles = document.querySelector('#agentRoles')
const refreshAgentRoles = document.querySelector('#refreshAgentRoles')
const skills = document.querySelector('#skills')
const refreshSkills = document.querySelector('#refreshSkills')
const projectList = document.querySelector('#projectList')
const conversationList = document.querySelector('#conversationList')
const newProject = document.querySelector('#newProject')
const newConversation = document.querySelector('#newConversation')
const deleteProject = document.querySelector('#deleteProject')
const deleteConversation = document.querySelector('#deleteConversation')

let pendingWorkflowId = null
let temporaryDraft = null
let pausedWorkflowId = null
let confirmationContext = null
let recoveryChoice = null
let planningProposalPending = false
let currentPlanningProposal = null
let subplanProposalPending = false
let currentSubplanProposal = null
let currentPlan = null
let currentPlanStatus = 'empty'
let currentStepIndex = -1
let completedStepIds = new Set()
let blockedStepId = null
let replanHistory = []
let instrumentLeases = []
let providerProfiles = []
let projects = []
let conversations = []
let currentProjectId = null
let currentConversationId = null
const assistantMessages = new Map()
const renderedEventIds = new Set()
let processTimer = null
let uiSource = null
let sessionId = sessionStorage.getItem('edmore-session-id') || `NOMAD-${newId().slice(0, 8)}`
let planMode = sessionStorage.getItem(`edmore-plan-mode:${sessionId}`) === '1'
let workflowAvailable = false
function setPlanMode(enabled) {
  planMode = enabled
  sessionStorage.setItem('edmore-session-id', sessionId)
  sessionStorage.setItem(`edmore-plan-mode:${sessionId}`, enabled ? '1' : '0')
  document.querySelector('#planModeIndicator').hidden = !enabled || !workflowAvailable
  if (!enabled) sessionStorage.removeItem(`edmore-source-draft:${sessionId}`)
}
setPlanMode(planMode)
promptInput.addEventListener('input', () => {
  const command = /^[\\/]plan(?:\s+|$)/i.exec(promptInput.value)
  if (!command || !workflowAvailable) return
  setPlanMode(true)
  promptInput.value = promptInput.value.slice(command[0].length)
})
document.querySelector('#exitPlanMode').addEventListener('click', () => { setPlanMode(false); promptInput.focus() })
let stateStream = null
let stateCursor = 0
let stateMore = false
let stateBusy = false
let stateGeneration = 0
let stateTimer = null
const statePane = document.querySelector('#sessionStateView')
const conversationPane = document.querySelector('#conversationView')
const viewTabs = [document.querySelector('#conversationTab'), document.querySelector('#sessionStateTab')]
let sessionStateAvailable = false
let workspaceLoaded = false
let workspaceLoading = false
const reportedCapabilityErrors = new Set()

async function refreshCapabilities() {
  const { capabilities } = await api('/api/edmore/capabilities')
  workflowAvailable = capabilities.some(item => item.id === 'edmore-plan-judge' && item.status === 'ready')
  if (!workflowAvailable) {
    for (const key of Object.keys(sessionStorage)) {
      if (key.startsWith('edmore-plan-mode:') || key.startsWith('edmore-source-draft:')) sessionStorage.removeItem(key)
    }
    setPlanMode(false)
  } else setPlanMode(planMode)
  sessionStateAvailable = capabilities.some(item => item.id === 'edmore-session-state-api' && item.status === 'ready')
  viewTabs[1].hidden = !sessionStateAvailable
  if (!sessionStateAvailable) selectSessionView(0)
  const workspaceReady = capabilities.some(item => item.id === 'edmore-workspace-api' && item.status === 'ready')
  for (const control of [newProject, newConversation, deleteProject, deleteConversation]) control.disabled = !workspaceReady
  if (workspaceReady && !workspaceLoaded && !workspaceLoading) {
    workspaceLoading = true
    try { await loadWorkspace(); workspaceLoaded = true }
    finally { workspaceLoading = false }
  }
  if (!workspaceReady && !uiSource) {
    await replayUiState()
    startUiStream()
  }
  for (const capability of capabilities) {
    if (capability.status !== 'failed' || reportedCapabilityErrors.has(capability.id)) continue
    reportedCapabilityErrors.add(capability.id)
    addMessage('gui', `${capability.id}: ${capability.error || 'Unavailable'}`)
  }
}

function selectSessionView(index) {
  if (index === 1 && !sessionStateAvailable) return
  stateGeneration++
  stateBusy = false
  viewTabs.forEach((tab, i) => { tab.setAttribute('aria-selected', String(i === index)); tab.tabIndex = i === index ? 0 : -1 })
  conversationPane.hidden = index === 1
  statePane.hidden = index !== 1
  if (index === 1) connectSessionState()
  else { stateStream?.close(); stateStream = null; clearTimeout(stateTimer); stateTimer = null }
}
viewTabs.forEach((tab, index) => {
  tab.addEventListener('click', () => selectSessionView(index))
  tab.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? 1 : 1 - index
    selectSessionView(next); viewTabs[next].focus()
  })
})

async function refreshSessionState(loadMore = false) {
  if (stateBusy || statePane.hidden) return
  stateBusy = true
  const generation = stateGeneration
  const query = `session_id=${encodeURIComponent(sessionId)}`
  try {
    const snapshot = await api(`/api/edmore-session-state/state?${query}`)
    if (generation !== stateGeneration) return
    document.querySelector('#sessionStateStatus').textContent = `${sessionId} · Version ${snapshot.version}`
    document.querySelector('#sessionStateData').textContent = JSON.stringify(snapshot, null, 2)
    const workflowStates = Object.entries(snapshot.workflows || {})
    document.querySelector('#sessionStateOverview').innerHTML = workflowStates.length ? workflowStates.map(([id, value]) => `
      <article class="state-workflow"><header><strong>${escapeHtml(value.status || 'Unknown')}</strong><span>${value.step_id ? `Step ${escapeHtml(value.step_id)}` : ''}</span></header>
      <div class="state-reference">${escapeHtml(id)}</div>
      ${value.reason ? `<p>${escapeHtml(String(value.reason))}</p>` : ''}
      <dl><div><dt>Tool calls</dt><dd>${Object.keys(value.calls || {}).length}</dd></div><div><dt>Confirmations</dt><dd>${Object.keys(value.gates || {}).length}</dd></div><div><dt>Assessments</dt><dd>${(value.assessments || []).length}</dd></div></dl></article>`).join('') : '<p class="nav-empty">No workflow state yet.</p>'
    document.querySelector('#sessionStateError').textContent = ''
    if (!stateMore || loadMore) {
      const data = await api(`/api/edmore-session-state/events?${query}&after=${stateCursor}&limit=100`)
      if (generation !== stateGeneration) return
      for (const row of data.events || []) {
        if (/\.delta$|heartbeat|context\.used/.test(row.event.type)) continue
        const detail = document.createElement('details')
        const title = document.createElement('summary')
        title.textContent = row.event.type.replace(/^edmore\./, '').replace(/[._]/g, ' ')
        const meta = document.createElement('div')
        meta.className = 'state-event-meta'
        meta.textContent = `#${row.version} · ${row.event.source}${row.event.timestamp ? ` · ${new Date(row.event.timestamp).toLocaleTimeString()}` : ''}`
        const body = document.createElement('pre')
        body.textContent = JSON.stringify(row.event, null, 2)
        detail.append(title, meta, body)
        document.querySelector('#sessionStateEvents').append(detail)
      }
      stateCursor = data.next_cursor ?? stateCursor
      stateMore = (data.events || []).length === 100
      document.querySelector('#sessionStateMore').hidden = !stateMore
    }
  } catch (error) {
    if (generation === stateGeneration) document.querySelector('#sessionStateError').textContent = error.message
  } finally { if (generation === stateGeneration) stateBusy = false }
}
function connectSessionState() {
  stateStream?.close()
  clearTimeout(stateTimer)
  stateTimer = null
  document.querySelector('#sessionStateExport').href = `/api/edmore-session-state/export?session_id=${encodeURIComponent(sessionId)}`
  stateStream = new EventSource(`/api/edmore-session-state/stream?session_id=${encodeURIComponent(sessionId)}`)
  stateStream.onmessage = () => { if (!stateTimer) stateTimer = setTimeout(() => { stateTimer = null; void refreshSessionState() }, 200) }
  stateStream.onerror = () => { document.querySelector('#sessionStateError').textContent = 'State connection interrupted. Reconnecting...' }
  void refreshSessionState()
}
document.querySelector('#sessionStateMore').addEventListener('click', () => refreshSessionState(true))

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
  })
  const json = await res.json()
  if (!res.ok || json.ok === false) throw new Error(json.error || `HTTP ${res.status}`)
  return json
}

function text(value) {
  return value === undefined || value === null ? '' : String(value)
}

function escapeHtml(value) {
  return text(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function inlineMarkdown(value) {
  return escapeHtml(value)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
}

function renderMarkdown(markdown) {
  const source = text(markdown).replace(/\r\n/g, '\n').trim()
  if (!source) return ''
  const blocks = []
  let inCode = false
  let code = []
  let paragraph = []
  let list = []

  const flushParagraph = () => {
    if (!paragraph.length) return
    blocks.push(`<p>${inlineMarkdown(paragraph.join(' '))}</p>`)
    paragraph = []
  }
  const flushList = () => {
    if (!list.length) return
    blocks.push(`<ul>${list.map(item => `<li>${inlineMarkdown(item)}</li>`).join('')}</ul>`)
    list = []
  }
  const flushCode = () => {
    if (!code.length) return
    blocks.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`)
    code = []
  }

  for (const line of source.split('\n')) {
    if (line.trim().startsWith('```')) {
      if (inCode) {
        flushCode()
        inCode = false
      } else {
        flushParagraph()
        flushList()
        inCode = true
      }
      continue
    }
    if (inCode) {
      code.push(line)
      continue
    }
    if (!line.trim()) {
      flushParagraph()
      flushList()
      continue
    }
    const heading = /^(#{1,3})\s+(.+)$/.exec(line)
    if (heading) {
      flushParagraph()
      flushList()
      const level = Math.min(heading[1].length + 2, 5)
      blocks.push(`<h${level}>${inlineMarkdown(heading[2])}</h${level}>`)
      continue
    }
    const bullet = /^\s*[-*]\s+(.+)$/.exec(line)
    if (bullet) {
      flushParagraph()
      list.push(bullet[1])
      continue
    }
    const numbered = /^\s*\d+[.)]\s+(.+)$/.exec(line)
    if (numbered) {
      flushParagraph()
      list.push(numbered[1])
      continue
    }
    paragraph.push(line.trim())
  }
  flushCode()
  flushParagraph()
  flushList()
  return blocks.join('')
}

function belongsToCurrentConversation(event) {
  return event.session_id === sessionId || event.session_id === undefined
}

function showProcess(message, detail = '') {
  if (processTimer) {
    clearTimeout(processTimer)
    processTimer = null
  }
  processStatus.hidden = false
  processStatus.classList.remove('settled')
  processStatus.innerHTML = `<span class="process-dot"></span><span>${escapeHtml(message)}</span>${detail ? `<code>${escapeHtml(detail)}</code>` : ''}`
  stopGeneration.disabled = false
}

function settleProcess(message = '') {
  if (message) showProcess(message)
  stopGeneration.disabled = true
  processStatus.classList.add('settled')
  processTimer = setTimeout(() => {
    processStatus.hidden = true
    processStatus.innerHTML = ''
    processStatus.classList.remove('settled')
  }, 2600)
}

function addMessage(role, message, id) {
  if (!message) return
  let bubble = id ? document.querySelector(`[data-message-id="${id}"]`) : null
  if (!bubble) {
    bubble = document.createElement('div')
    bubble.className = `message ${role}`
    if (id) bubble.dataset.messageId = id
    const body = document.createElement('div')
    body.className = 'message-body'
    bubble.append(body)
    chatHistory.append(bubble)
  }
  const body = bubble.querySelector('.message-body')
  if (role === 'bot') body.innerHTML = renderMarkdown(message)
  else body.textContent = message
  chatHistory.scrollTop = chatHistory.scrollHeight
}

function addEventRow(event) {
  if (renderedEventIds.has(event.event_id)) return
  renderedEventIds.add(event.event_id)
  const li = document.createElement('li')
  li.innerHTML = `<code>${event.cursor}</code> <span>${escapeHtml(event.type.replace(/^edmore\.ui\./, ''))}</span>`
  events.prepend(li)
}

function setPending(plan) {
  pendingWorkflowId = plan?.workflow_id || null
  planningProposalPending = false
  currentPlanningProposal = null
  subplanProposalPending = false
  currentSubplanProposal = null
  currentPlan = plan || currentPlan
  currentPlanStatus = plan ? 'waiting' : (currentPlan ? currentPlanStatus : 'empty')
  if (plan) {
    currentStepIndex = -1
    completedStepIds = new Set()
    blockedStepId = null
    replanHistory = Array.isArray(plan.judge_replan_history) ? plan.judge_replan_history.slice() : []
  }
  renderPlanSection()
  updatePlanActionButtons()
}

function clearPlanSection() {
  pendingWorkflowId = null
  pausedWorkflowId = null
  planningProposalPending = false
  currentPlanningProposal = null
  subplanProposalPending = false
  currentSubplanProposal = null
  currentPlan = null
  currentPlanStatus = 'empty'
  currentStepIndex = -1
  completedStepIds = new Set()
  blockedStepId = null
  replanHistory = []
  renderPlanSection()
  updatePlanActionButtons()
}

function setPausedWorkflow(workflowId) {
  confirmationContext = null
  recoveryChoice = null
  pausedWorkflowId = workflowId || null
  if (!pausedWorkflowId) {
    subplanProposalPending = false
    currentSubplanProposal = null
  }
  confirmWorkflow.hidden = !pausedWorkflowId
  confirmWorkflow.disabled = !pausedWorkflowId
  updatePlanActionButtons()
}

function setRecoveryChoice(choice, stepId) {
  recoveryChoice = choice ? { ...choice, workflow_id: pausedWorkflowId, step_id: stepId } : null
  if (recoveryChoice) {
    confirmWorkflow.hidden = true
    confirmWorkflow.disabled = true
  }
}

function setSubplanProposal(proposal) {
  subplanProposalPending = Boolean(proposal)
  currentSubplanProposal = proposal || null
  updatePlanActionButtons()
  renderPlanSection()
}

function setPlanningProposal(proposal) {
  if (proposal) clearPlanSection()
  planningProposalPending = Boolean(proposal)
  currentPlanningProposal = proposal || null
  if (proposal) {
    pendingWorkflowId = null
    subplanProposalPending = false
    currentSubplanProposal = null
    currentPlanStatus = 'proposal'
  }
  updatePlanActionButtons()
  renderPlanSection()
}

function updatePlanActionButtons() {
  approve.disabled = !pendingWorkflowId && !subplanProposalPending && !planningProposalPending
  if (temporaryDraft?.dirty && temporaryDraft.id === pendingWorkflowId) approve.disabled = true
  reject.disabled = !pendingWorkflowId && !subplanProposalPending && !planningProposalPending
  approve.textContent = planningProposalPending && !pendingWorkflowId ? 'Approve direction' : (subplanProposalPending && !pendingWorkflowId ? 'Approve subplan' : 'Approve')
  reject.textContent = planningProposalPending && !pendingWorkflowId ? 'Reject direction' : (subplanProposalPending && !pendingWorkflowId ? 'Reject subplan' : 'Reject')
}

function planStatusLabel() {
  if (currentPlanStatus === 'proposal') return 'Direction approval'
  if (currentPlanStatus === 'waiting') return 'Waiting for approval'
  if (currentPlanStatus === 'running') return 'Running'
  if (currentPlanStatus === 'paused') return 'Paused'
  if (currentPlanStatus === 'completed') return 'Completed'
  if (currentPlanStatus === 'cancelled') return 'Cancelled'
  if (currentPlanStatus === 'failed') return 'Failed'
  if (currentPlanStatus === 'rejected') return 'Rejected'
  if (currentPlanStatus === 'blocked') return 'Blocked by judge'
  return 'No plan'
}

function renderPlanSection() {
  instrumentOccupancy.innerHTML = instrumentLeases.length ? `<strong>Instrument occupancy</strong>${instrumentLeases.map((lease, index) => `
    <div class="plan-gate">
      <strong>${escapeHtml(lease.instrument_id)} · ${escapeHtml(lease.state)}</strong>
      <div>Session: ${escapeHtml(lease.session_id)}</div>
      <div>Workflow: ${escapeHtml(lease.workflow_id)}</div>
      <p>${escapeHtml(lease.reason || '')}</p>
      <button type="button" data-lease-index="${index}">Open workflow</button>
      <button type="button" data-lease-index="${index}" data-cancel-workflow="true">Cancel workflow</button>
      ${lease.state === 'verify_required' ? `<button type="button" data-lease-index="${index}" data-cancel-paused="true">Verify stopped and release reservation</button>` : ''}
    </div>`).join('')}` : ''
  pending.classList.toggle('empty', !currentPlan && !currentPlanningProposal)
  if (!currentPlan && currentPlanningProposal) {
    pending.innerHTML = `
      <div class="plan-title">Planning direction</div>
      <div class="plan-meta">
        <span>${escapeHtml(planStatusLabel())}</span>
        <span>${escapeHtml(currentPlanningProposal.proposal_id || '')}</span>
      </div>
      <div class="subplan-proposal">
        <strong>Proposed approach</strong>
        <p>${escapeHtml(currentPlanningProposal.user_message || 'A formal PlanReview can be created from this direction.')}</p>
        ${currentPlanningProposal.plan_goal ? `<div class="plan-gate">Goal: ${escapeHtml(currentPlanningProposal.plan_goal)}</div>` : ''}
        ${currentPlanningProposal.reason ? `<div class="plan-gate">Reason: ${escapeHtml(currentPlanningProposal.reason)}</div>` : ''}
      </div>
    `
    return
  }
  if (!currentPlan) {
    pending.innerHTML = 'No workflow in this conversation'
    return
  }
  const steps = Array.isArray(currentPlan.steps) ? currentPlan.steps : []
  const judge = currentPlan.judge_report || {}
  const leaseRows = instrumentLeases.length
    ? `
      <div class="plan-leases">
        ${instrumentLeases.map(lease => `
          <div class="plan-lease ${escapeHtml(lease.state || 'active')}">
            <span>${escapeHtml(lease.instrument_id || 'instrument')}</span>
            <strong>${escapeHtml(lease.state || 'active')}</strong>
            <small>${escapeHtml(lease.session_id || '')}</small>
          </div>
        `).join('')}
      </div>
    `
    : ''
  const replanRows = replanHistory.length
    ? `
      <details class="plan-replan">
        <summary>Judge / repair history</summary>
        ${replanHistory.slice(-4).map(item => `<p>${escapeHtml(item)}</p>`).join('')}
      </details>
    `
    : ''
  const subplanProposal = currentSubplanProposal
    ? `
      <div class="subplan-proposal">
        <strong>Subplan proposal</strong>
        <p>${escapeHtml(currentSubplanProposal.user_message || currentSubplanProposal.reason || 'A child plan was proposed for this paused workflow.')}</p>
        ${currentSubplanProposal.subplan_goal ? `<div class="plan-gate">Goal: ${escapeHtml(currentSubplanProposal.subplan_goal)}</div>` : ''}
      </div>
    `
    : ''
  const issueRows = Array.isArray(judge.issues) && judge.issues.length
    ? `
      <details class="plan-replan">
        <summary>Judge issues (${judge.issues.length})</summary>
        ${judge.issues.map(issue => `<p>${escapeHtml(`${issue.step_id ? `Step ${issue.step_id}: ` : ''}${issue.message || issue.category || 'Unspecified issue'}`)}</p>`).join('')}
      </details>
    `
    : ''
  const rows = steps.map((step, index) => {
    const stepId = String(step.step_id || index + 1)
    let state = 'pending'
    if (completedStepIds.has(stepId)) state = 'done'
    else if (blockedStepId === stepId || (currentPlanStatus === 'paused' && index === currentStepIndex)) state = 'blocked'
    else if (currentPlanStatus === 'running' && index === currentStepIndex) state = 'running'
    const tool = step.kind === 'confirmation' ? 'User confirmation' : [step.agent, step.tool_name].filter(Boolean).join('.')
    const gates = Array.isArray(step.required_inputs) && step.required_inputs.length
      ? `<div class="plan-gate">Gate: ${escapeHtml(step.required_inputs.join('; '))}</div>`
      : ''
    return `
      <li class="plan-step ${state}">
        <span class="plan-step-marker">${escapeHtml(index + 1)}</span>
        <div class="plan-step-body">
          <div class="plan-step-title">${escapeHtml(step.goal || tool || `Step ${index + 1}`)}</div>
          <div class="plan-step-meta">${escapeHtml(tool)} · ${escapeHtml(state)}</div>
          ${gates}
        </div>
      </li>
    `
  }).join('')
  pending.innerHTML = `
    <details class="workflow-description">
      <summary><span class="workflow-preview">${escapeHtml(currentPlan.goal || currentPlan.summary || 'Workflow')}</span><span class="workflow-expand">Details</span></summary>
      <p>${escapeHtml(currentPlan.summary || currentPlan.goal || '')}</p>
    </details>
    <div class="plan-meta">
      <span>${escapeHtml(planStatusLabel())}</span>
      <span>${currentPlan.planning_mode === 'temporary' ? 'No Contract / Plan Judge skipped' : `Judge: ${escapeHtml(judge.status || 'unknown')}`}</span>
      <span>${escapeHtml(currentPlan.workflow_id || '')}</span>
    </div>
    ${leaseRows}
    ${replanRows}
    ${issueRows}
    ${subplanProposal}
    ${recoveryChoice ? `<section><strong>Diagnostic recovery</strong><p>${escapeHtml((recoveryChoice.failures || []).join(', '))}</p>
      ${(recoveryChoice.options || []).map(option => `<p><strong>${escapeHtml(option.id)}</strong>: ${escapeHtml(option.description)}</p>`).join('')}
      <select aria-label="Recovery action" id="recoveryAction"><option value="">Select an action</option>${(recoveryChoice.options || []).map(option => `<option value="${escapeHtml(option.id)}">${escapeHtml(option.id)}</option>`).join('')}<option value="retry_check">Recheck diagnostics</option></select>
      <button type="button" data-recovery-version="${escapeHtml(recoveryChoice.version)}">Run selected action</button></section>` : ''}
    <ol class="plan-steps">${rows}</ol>
    ${currentPlan.planning_mode === 'temporary' && pendingWorkflowId ? `<section class="temporary-plan-editor">
      <strong>No Workflow Contract</strong><p>Plan Judge was skipped. Check the device, arguments and effects before approval.</p>
      <label for="temporaryPlanJson">Plan JSON</label><textarea id="temporaryPlanJson" spellcheck="false" rows="16">${escapeHtml(temporaryDraft?.id === pendingWorkflowId ? temporaryDraft.text : JSON.stringify({ goal: currentPlan.goal, summary: currentPlan.summary, steps: currentPlan.steps.map(s => ({ agent: s.agent, tool_name: s.tool_name, goal: s.goal, arguments: s.arguments, success_criterion: s.completion?.criteria || '' })) }, null, 2))}</textarea>
      <button type="button" id="saveTemporaryPlan">Save changes</button><p id="temporaryPlanError" role="alert"></p>
    </section>` : ''}
  `
}

function stepIndexById(stepId) {
  const steps = Array.isArray(currentPlan?.steps) ? currentPlan.steps : []
  return steps.findIndex(step => String(step.step_id) === String(stepId))
}

function setRunningStepFromPayload(payload = {}) {
  const step = payload.step && typeof payload.step === 'object' ? payload.step : null
  const stepId = step?.step_id || payload.step_id
  if (stepId !== undefined) {
    const index = stepIndexById(stepId)
    if (index >= 0) currentStepIndex = index
  }
  currentPlanStatus = 'running'
  blockedStepId = null
  renderPlanSection()
}

function formatTime(value) {
  if (!value) return ''
  try {
    return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(value))
  } catch {
    return ''
  }
}

async function workspaceApi(path, options = {}) {
  return api(`/api/edmore-workspace${path}`, options)
}

function renderProjectList() {
  projectList.innerHTML = ''
  for (const project of projects) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = `nav-item ${project.id === currentProjectId ? 'active' : ''}`
    button.innerHTML = `
      <span class="nav-title">${escapeHtml(project.name)}</span>
      <span class="nav-subtitle">${escapeHtml(project.cwd)}</span>
    `
    button.onclick = async () => {
      currentProjectId = project.id
      localStorage.setItem('edmore-current-project-id', currentProjectId)
      await loadConversations()
      renderProjectList()
    }
    projectList.append(button)
  }
}

function renderConversationList() {
  conversationList.innerHTML = ''
  if (!conversations.length) {
    const empty = document.createElement('div')
    empty.className = 'nav-empty'
    empty.textContent = currentProjectId ? 'No conversations yet.' : 'Select a project first.'
    conversationList.append(empty)
    return
  }
  for (const conversation of conversations) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = `nav-item ${conversation.id === currentConversationId ? 'active' : ''}`
    button.innerHTML = `
      <span class="nav-title">${escapeHtml(conversation.title || 'New conversation')}</span>
      <span class="nav-subtitle">${escapeHtml(conversation.last_message_preview || formatTime(conversation.updated_at))}</span>
    `
    button.onclick = async () => selectConversation(conversation)
    conversationList.append(button)
  }
}

async function loadWorkspace() {
  const data = await workspaceApi('/projects')
  projects = data.projects || []
  currentProjectId = localStorage.getItem('edmore-current-project-id')
  if (!projects.some(project => project.id === currentProjectId)) currentProjectId = projects[0]?.id || null
  if (currentProjectId) localStorage.setItem('edmore-current-project-id', currentProjectId)
  renderProjectList()
  await loadConversations()
}

async function loadConversations() {
  if (!currentProjectId) {
    conversations = []
    renderConversationList()
    await selectConversation(null)
    return
  }
  const data = await workspaceApi(`/conversations?project_id=${encodeURIComponent(currentProjectId)}`)
  conversations = data.conversations || []
  const preferred = localStorage.getItem('edmore-current-conversation-id')
  const next = conversations.find(item => item.id === preferred) || conversations[0]
  renderConversationList()
  await selectConversation(next, { rerender: false })
}

async function createConversation(title = 'New conversation') {
  const data = await workspaceApi('/conversations', {
    method: 'POST',
    body: JSON.stringify({ project_id: currentProjectId, title, ...(!currentConversationId ? { session_id: sessionId } : {}) }),
  })
  conversations = [data.conversation, ...conversations.filter(item => item.id !== data.conversation.id)]
  renderConversationList()
  return data.conversation
}

async function deleteCurrentConversation() {
  if (!currentConversationId) return
  const conversation = conversations.find(item => item.id === currentConversationId)
  const title = conversation?.title || 'this conversation'
  if (!window.confirm(`Delete conversation "${title}" from this project?`)) return
  await workspaceApi(`/conversations?id=${encodeURIComponent(currentConversationId)}`, { method: 'DELETE' })
  conversations = conversations.filter(item => item.id !== currentConversationId)
  localStorage.removeItem('edmore-current-conversation-id')
  currentConversationId = null
  const next = conversations[0]
  renderConversationList()
  await selectConversation(next, { rerender: false })
}

async function deleteCurrentProject() {
  if (!currentProjectId) return
  const project = projects.find(item => item.id === currentProjectId)
  const name = project?.name || 'this project'
  if (!window.confirm(`Delete project "${name}"? Conversations must be deleted first.`)) return
  await workspaceApi(`/projects?id=${encodeURIComponent(currentProjectId)}`, { method: 'DELETE' })
  projects = projects.filter(item => item.id !== currentProjectId)
  localStorage.removeItem('edmore-current-project-id')
  localStorage.removeItem('edmore-current-conversation-id')
  currentProjectId = projects[0]?.id || null
  currentConversationId = null
  renderProjectList()
  await loadConversations()
}

async function touchConversation(fields = {}) {
  if (!currentConversationId) return
  try {
    const data = await workspaceApi('/conversations/touch', {
      method: 'POST',
      body: JSON.stringify({ id: currentConversationId, session_id: sessionId, ...fields }),
    })
    conversations = [data.conversation, ...conversations.filter(item => item.id !== data.conversation.id)]
    renderConversationList()
  } catch {
    // Conversation metadata is an index cache; losing a touch must not break the workflow.
  }
}

async function selectConversation(conversation, options = {}) {
  const empty = !conversation
  conversation ||= { id: null, session_id: `NOMAD-${newId()}` }
  if (uiSource) { uiSource.close(); uiSource = null }
  currentConversationId = conversation.id
  sessionId = conversation.session_id
  document.querySelector('#modelStatus').textContent = ''
  refreshConversationModel().catch(error => { document.querySelector('#modelStatus').textContent = error.message })
  sessionStorage.setItem('edmore-session-id', sessionId)
  setPlanMode(sessionStorage.getItem(`edmore-plan-mode:${sessionId}`) === '1')
  stateGeneration++
  stopGeneration.disabled = true
  stateBusy = false
  stateCursor = 0
  stateMore = false
  document.querySelector('#sessionStateEvents').replaceChildren()
  document.querySelector('#sessionStateData').textContent = 'Loading...'
  document.querySelector('#sessionStateOverview').replaceChildren()
  if (!statePane.hidden) connectSessionState()
  if (currentConversationId) localStorage.setItem('edmore-current-conversation-id', currentConversationId)
  else localStorage.removeItem('edmore-current-conversation-id')
  pendingWorkflowId = null
  pausedWorkflowId = null
  chatHistory.innerHTML = ''
  events.innerHTML = ''
  renderedEventIds.clear()
  assistantMessages.clear()
  setPending(null)
  setPausedWorkflow(null)
  clearPlanSection()
  if (options.rerender !== false) renderConversationList()
  if (empty) { settleProcess(); return }
  await replayUiState()
  startUiStream()
}

function renderUiEvent(event) {
  if (renderedEventIds.has(event.event_id)) return
  addEventRow(event)
  if (event.type === 'edmore.ui.workflow.mode_disabled') {
    workflowAvailable = false
    setPlanMode(false)
    void refreshCapabilities()
  }
  if (event.type === 'edmore.ui.workflow.mode_enabled' && workflowAvailable && belongsToCurrentConversation(event)) {
    const key = `edmore-mode-event:${event.event_id}`
    if (!sessionStorage.getItem(key)) {
      sessionStorage.setItem(key, '1')
      setPlanMode(true)
      if (event.payload?.source_draft_id) sessionStorage.setItem(`edmore-source-draft:${sessionId}`, event.payload.source_draft_id)
      if (!promptInput.value.trim()) promptInput.value = text(event.payload?.draft)
    }
  }
  if (event.type === 'edmore.ui.conversation.user_message') {
    if (belongsToCurrentConversation(event)) {
      addMessage('user', text(event.payload?.text), event.event_id)
      showProcess('Thinking')
    }
  } else if (event.type === 'edmore.ui.conversation.assistant_message') {
    if (belongsToCurrentConversation(event)) {
      addMessage('bot', text(event.payload?.text), event.payload?.response_id || event.event_id)
      touchConversation({ last_message_preview: text(event.payload?.text) })
      settleProcess()
    }
  } else if (event.type === 'edmore.ui.workflow.pending_plan') {
    if (belongsToCurrentConversation(event)) setPending(event.payload?.plan)
  } else if (event.type === 'edmore.ui.workflow.replan_requested') {
    if (belongsToCurrentConversation(event)) {
      const attempt = event.payload?.attempt
      const summary = text(event.payload?.summary || 'Plan judge requested repair')
      const prefix = attempt ? `Auto-replan #${attempt}: ` : ''
      replanHistory = [...replanHistory, `${prefix}${summary}`].slice(-12)
      renderPlanSection()
      showProcess(attempt ? `Replanning ${attempt}/${event.payload?.max_attempts || '?'}` : 'Replanning', summary)
    }
  } else if (event.type === 'edmore.ui.workflow.plan_blocked') {
    if (belongsToCurrentConversation(event)) {
      currentPlan = event.payload?.plan || null
      pendingWorkflowId = null
      currentPlanStatus = 'blocked'
      updatePlanActionButtons()
      renderPlanSection()
      settleProcess('Plan blocked after judge review')
    }
  } else if (event.type === 'edmore.ui.workflow.planning_proposal') {
    if (belongsToCurrentConversation(event)) {
      setPlanningProposal(event.payload || {})
      showProcess('Planning direction waiting for approval')
    }
  } else if (event.type === 'edmore.ui.workflow.planning_proposal_cleared') {
    if (belongsToCurrentConversation(event)) {
      setPlanningProposal(null)
      showProcess('Creating formal plan')
    }
  } else if (event.type === 'edmore.ui.workflow.pending_plan_cleared') {
    if (belongsToCurrentConversation(event)) {
      pendingWorkflowId = null
      if (currentPlanStatus === 'waiting') currentPlanStatus = 'running'
      updatePlanActionButtons()
      renderPlanSection()
    }
  } else if (event.type === 'edmore.ui.workflow.paused') {
    if (belongsToCurrentConversation(event)) {
      setPausedWorkflow(event.payload?.workflow_id || event.workflow_id)
      setRecoveryChoice(event.payload?.recovery_choice, event.payload?.step?.step_id)
      if (event.payload?.confirmation?.version) confirmationContext = { workflow_id: pausedWorkflowId, step_id: event.payload.step?.step_id, version: event.payload.confirmation.version, review_version: event.payload.review_version }
      currentPlanStatus = 'paused'
      const step = event.payload?.step
      const stepId = step?.step_id
      if (stepId !== undefined) {
        blockedStepId = String(stepId)
        const index = stepIndexById(stepId)
        if (index >= 0) currentStepIndex = index
      }
      renderPlanSection()
      showProcess('Workflow paused')
    }
  } else if (event.type === 'edmore.ui.workflow.subplan_proposal') {
    if (belongsToCurrentConversation(event)) {
      setSubplanProposal(event.payload || {})
      showProcess('Subplan proposal waiting for approval')
    }
  } else if (event.type === 'edmore.ui.workflow.subplan_accepted') {
    if (belongsToCurrentConversation(event)) {
      setSubplanProposal(null)
      showProcess('Creating child plan')
    }
  } else if (event.type === 'edmore.ui.workflow.started') {
    if (belongsToCurrentConversation(event)) {
      if (!currentPlan && Array.isArray(event.payload?.steps)) {
        currentPlan = {
          workflow_id: event.payload?.workflow_id || event.workflow_id,
          summary: 'Approved workflow',
          steps: event.payload.steps,
          judge_report: { status: 'pass' },
        }
      }
      currentPlanStatus = 'running'
      currentStepIndex = 0
      blockedStepId = null
      renderPlanSection()
      showProcess('Workflow started')
    }
  } else if (event.type === 'edmore.ui.workflow.resumed') {
    if (belongsToCurrentConversation(event)) {
      if (event.payload?.plan) {
        currentPlan = event.payload.plan
        currentStepIndex = event.payload.next_step_index ?? 0
        completedStepIds = new Set(currentPlan.steps.slice(0, currentStepIndex).map(step => String(step.step_id)))
      }
      setPausedWorkflow(null)
      currentPlanStatus = 'running'
      blockedStepId = null
      renderPlanSection()
      showProcess('Workflow resumed')
    }
  } else if (event.type === 'edmore.ui.workflow.cancelled') {
    instrumentLeases = instrumentLeases.filter(lease => lease.workflow_id !== event.payload?.workflow_id)
    if (belongsToCurrentConversation(event)) {
      setPausedWorkflow(null)
      setSubplanProposal(null)
      currentPlanStatus = 'cancelled'
      settleProcess('Workflow cancelled')
    }
    renderPlanSection()
  } else if (event.type === 'edmore.ui.workflow.completed') {
    if (belongsToCurrentConversation(event)) {
      setPausedWorkflow(null)
      currentPlanStatus = 'completed'
      if (currentPlan?.steps) {
        completedStepIds = new Set(currentPlan.steps.map(step => String(step.step_id)))
        currentStepIndex = currentPlan.steps.length - 1
      }
      blockedStepId = null
      renderPlanSection()
      settleProcess('Workflow completed')
    }
  } else if (event.type === 'edmore.ui.workflow.failed') {
    if (belongsToCurrentConversation(event)) {
      setPausedWorkflow(null)
      currentPlanStatus = 'failed'
      renderPlanSection()
      settleProcess('Workflow failed')
    }
  } else if (event.type === 'edmore.ui.process.started' || event.type === 'edmore.ui.process.updated') {
    if (belongsToCurrentConversation(event)) showProcess(text(event.payload?.label || 'Working'), text(event.payload?.detail))
  } else if (event.type === 'edmore.ui.process.completed') {
    if (belongsToCurrentConversation(event)) settleProcess(text(event.payload?.label || 'Done'))
  } else if (event.type === 'edmore.ui.status.updated' && event.payload?.area === 'llm') {
    refreshProviders().catch(error => { providerStatus.textContent = error.message })
  } else if (event.type === 'edmore.ui.status.updated' && event.payload?.area === 'tools') {
    refreshHarnessToolRegistry().catch(error => { harnessTools.textContent = error.message })
  } else if (event.type === 'edmore.ui.conversation.updated') {
    const updated = event.payload?.conversation
    if (updated?.id) {
      conversations = [updated, ...conversations.filter(item => item.id !== updated.id)]
      renderConversationList()
    } else {
      loadConversations().catch(() => {})
    }
  } else if (event.type === 'edmore.ui.status.updated') {
    refreshState().catch(() => {})
  } else if (event.type === 'edmore.ui.tool.call') {
    if (belongsToCurrentConversation(event)) {
      setRunningStepFromPayload(event.payload)
      showProcess('Calling tool', event.payload?.name)
    }
  } else if (event.type === 'edmore.ui.tool.result') {
    if (belongsToCurrentConversation(event)) showProcess('Tool completed')
  } else if (event.type === 'edmore.ui.hardware.observed' || event.type === 'edmore.ui.confirmation.accepted') {
    if (belongsToCurrentConversation(event)) {
      const stepId = event.payload?.step_id
      if (stepId !== undefined) {
        completedStepIds.add(String(stepId))
        const index = stepIndexById(stepId)
        if (index >= 0) currentStepIndex = index + 1
      }
      currentPlanStatus = 'running'
      blockedStepId = null
      renderPlanSection()
      showProcess('Step observed', event.payload?.step_id)
    }
  }
}

function fillProviderForm(profile) {
  if (!profile) return
  providerId.value = profile.id || ''
  providerName.value = profile.displayName || profile.id || ''
  providerBaseUrl.value = profile.baseURL || ''
  providerModel.value = profile.model || ''
  providerEmbeddingModel.value = profile.embeddingModel || ''
  providerApiKey.value = ''
  const shared = authenticatedUser && profile.id !== 'openai'
  for (const field of [providerId, providerBaseUrl, providerModel, providerEmbeddingModel, providerApiKey]) field.disabled = shared
  if (authenticatedUser) { providerId.disabled = true; providerBaseUrl.disabled = true; providerEmbeddingModel.disabled = true }
  document.querySelector('#providerForm button[type=submit]').disabled = shared
}

function selectedProvider() {
  return providerProfiles.find(profile => profile.id === providerSelect.value)
}

async function refreshProviders() {
  const data = await api('/api/edmore/llm/providers')
  providerProfiles = data.profiles || []
  providerSelect.innerHTML = ''
  for (const profile of providerProfiles) {
    const option = document.createElement('option')
    option.value = profile.id
    option.textContent = `${profile.displayName || profile.id}${profile.active ? ' (active)' : ''}`
    providerSelect.append(option)
  }
  providerSelect.value = data.activeProvider
  const roleModelSelect = document.querySelector('#roleModelSelect')
  const previousModel = roleModelSelect.value
  roleModelSelect.replaceChildren(...providerProfiles.map(profile => new Option(`${profile.displayName || profile.id} · ${profile.model}`, JSON.stringify([profile.id, profile.model]))))
  if ([...roleModelSelect.options].some(option => option.value === previousModel)) roleModelSelect.value = previousModel
  const active = providerProfiles.find(profile => profile.id === data.activeProvider)
  fillProviderForm(active || providerProfiles[0])
  providerBadge.textContent = `Provider: ${data.activeProvider}`
  const credential = active?.credential?.configured ? 'key configured' : 'key missing'
  providerStatus.textContent = `${active?.displayName || data.activeProvider}: ${active?.model || 'no model'}; ${credential}`
  await refreshConversationModel()
}

async function refreshState() {
  const health = await api('/api/edmore/health')
  runtime.textContent = `Runtime: ${health.runtime}; Session: ${sessionId}`
  mcpStatus.textContent = `MCP: ${health.nionswift.ok ? 'online' : 'offline'}`
  mcpStatus.title = health.nionswift.message
  agents.innerHTML = ''
  for (const agent of health.nionswift.agents || []) {
    const button = document.createElement('button')
    button.className = 'chip'
    button.type = 'button'
    button.textContent = agent
    button.onclick = async () => {
      tools.textContent = 'Loading...'
      try {
        tools.textContent = JSON.stringify(await api(`/api/edmore/nionswift/tools?agent=${encodeURIComponent(agent)}`), null, 2)
      } catch (error) {
        tools.textContent = error.message
      }
    }
    agents.append(button)
  }
}

async function refreshHarnessToolRegistry() {
  const data = await api('/api/edmore/harness/tools')
  const tools = data.tools || []
  harnessTools.textContent = tools.length
    ? tools.map(tool => `${tool.name}\n${tool.description || '(no description)'}`).join('\n\n')
    : 'No Harness MCP tools registered'
}

async function refreshAgentRolesRegistry() {
  const data = await api('/api/edmore/agent-roles')
  const roles = data.roles || {}
  const roleSelect = document.querySelector('#roleSelect')
  const previousRole = roleSelect.value
  roleSelect.replaceChildren(...Object.keys(roles).map(role => new Option(role, role)))
  if (roles[previousRole]) roleSelect.value = previousRole
  const sourceLabel = source => ({
    user_role: 'user role',
    mcp_agent: 'MCP agent',
    backend_default: 'backend default',
  })[source] || 'unknown'
  const rows = Object.entries(roles)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([role, config]) => {
      const provider = config.provider || 'active provider'
      const model = config.model || 'active model'
      const effort = config.reasoningEffort ? `; ${config.reasoningEffort}` : ''
      const sources = config.sources || {}
      return [
        role,
        `${provider} (${sourceLabel(sources.provider)}) / ${model} (${sourceLabel(sources.model)})${effort}`,
        `max ${config.maxTokens}; timeout ${config.timeoutMs} ms`,
      ].join('\n')
    })
  agentRoles.textContent = rows.length ? rows.join('\n\n') : 'No EDMORE agent roles configured'
}

const activeActionRequests = new Map()

function actionStorageKey(kind, payload) {
  return `edmore.action.${kind}.${sessionId}.${payload.workflow_id || payload.prompt || 'global'}`
}

async function sendAction(kind, path, payload) {
  const key = actionStorageKey(kind, payload)
  const active = activeActionRequests.get(key)
  if (active) return await active
  let actionId = localStorage.getItem(key)
  if (!actionId) {
    actionId = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`
    localStorage.setItem(key, actionId)
  }
  const request = api(path, {
    method: 'POST',
    body: JSON.stringify({ ...payload, action_id: actionId }),
  }).then(result => {
    localStorage.removeItem(key)
    return result
  }).finally(() => activeActionRequests.delete(key))
  activeActionRequests.set(key, request)
  return await request
}

async function refreshSkillCatalog() {
  const data = await api('/api/edmore/skills')
  const list = data.skills || []
  skills.replaceChildren()
  for (const [category, title] of [['workflow', 'Workflows'], ['support', 'Skills'], ['unknown', 'Unclassified']]) {
    const entries = list.filter(entry => (entry.category || 'unknown') === category)
    if (!entries.length) continue
    const heading = document.createElement('h3'); heading.textContent = title; skills.append(heading)
    for (const entry of entries) {
      const item = document.createElement('p'), name = document.createElement('strong'), description = document.createElement('div')
      name.textContent = entry.name; description.textContent = entry.description || '(no description)'
      item.append(name, description); skills.append(item)
    }
  }
  if (!list.length) skills.textContent = 'No Workflows or Skills discovered'
}

async function refreshPendingFromState() {
  const targetSession = sessionId
  const generation = stateGeneration
  const state = await api(`/api/edmore/ui/state?session_id=${encodeURIComponent(targetSession)}&limit=1`)
  if (targetSession !== sessionId || generation !== stateGeneration) return
  const historicalPlan = currentPlan
  clearPlanSection()
  instrumentLeases = state.workflow?.instrument_leases || []
  const proposals = state.workflow?.planning_proposals || []
  const proposal = proposals.find(item => item.session_id === sessionId) || null
  setPlanningProposal(proposal)
  const pendingPlans = state.workflow?.pending || []
  const active = pendingPlans.find(plan => plan.session_id === sessionId)
  if (active) setPending(active)
  const running = (state.workflow?.active || []).find(item => item.session_id === sessionId)
  const paused = (state.workflow?.paused || []).find(item => item.session_id === sessionId)
  if (!active && !running && paused) {
    currentPlan = paused.plan || (historicalPlan?.workflow_id === paused.workflow_id ? historicalPlan : null)
    currentPlanStatus = 'paused'
    currentStepIndex = paused.state?.next_step_index ?? -1
  }
  if (!active && running?.plan) {
    currentPlan = running.plan
    pendingWorkflowId = null
    currentStepIndex = running.next_step_index
    completedStepIds = new Set(running.plan.steps.slice(0, currentStepIndex).map(step => String(step.step_id)))
    currentPlanStatus = paused ? 'paused' : 'running'
  }
  setPausedWorkflow(paused?.workflow_id)
  setRecoveryChoice(paused?.state?.recovery_choice, paused?.state?.step_id)
  if (paused?.state?.confirmation?.version) confirmationContext = { workflow_id: paused.workflow_id, step_id: paused.state.step_id, version: paused.state.confirmation.version, review_version: paused.state.review_version }
  setSubplanProposal(paused?.recovery_proposal || null)
  renderPlanSection()
}

instrumentOccupancy.addEventListener('click', async event => {
  const button = event.target.closest('[data-lease-index]')
  if (!button) return
  const lease = instrumentLeases[Number(button.dataset.leaseIndex)]
  if (!lease) return
  if (button.dataset.cancelWorkflow) {
    button.disabled = true
    try {
      const result = await api('/api/edmore/actions/cancel-workflow', { method: 'POST', body: JSON.stringify({ session_id: lease.session_id }) })
      if (sessionId === lease.session_id) { clearPlanSection(); setPausedWorkflow(null); settleProcess('Workflow cancelled') }
      await refreshPendingFromState()
      addMessage('gui', result.hardware_stop_verified ? 'Selected workflow cancelled. Instrument reservation released; chat history retained.' : 'Selected workflow cancelled. Verify hardware stopped before releasing its reservation.')
    } catch (error) { addMessage('gui', error.message); button.disabled = false }
    return
  }
  if (button.dataset.cancelPaused) {
    if (!window.confirm(`Clear ALL workflow state in session ${lease.session_id}?\n\nThis cancels paused workflows, recovery children, pending plans and planning proposals, and releases this session's instrument reservations. Chat history and other sessions are retained. It does NOT stop hardware or undo previous actions. Continue only after verifying that acquisition and hardware operations have stopped.`)) return
    button.disabled = true
    try {
      await api('/api/edmore/actions/cancel-paused', { method: 'POST', body: JSON.stringify({
        workflow_id: lease.workflow_id, session_id: lease.session_id, hardware_stop_verified: true,
        action_id: newId(),
      }) })
      if (sessionId === lease.session_id) { clearPlanSection(); setPausedWorkflow(null) }
      await refreshPendingFromState()
      addMessage('gui', 'All workflow state in the selected session cleared; instrument reservations released. Chat history retained.')
    } catch (error) { addMessage('gui', error.message); button.disabled = false; await refreshPendingFromState() }
    return
  }
  const conversation = conversations.find(item => item.session_id === lease.session_id)
  try {
    await selectConversation(conversation || { id: null, session_id: lease.session_id })
    settingsDialog.close()
  } catch (error) { addMessage('gui', error.message) }
})

async function replayUiState() {
  const targetSession = sessionId
  const generation = stateGeneration
  const data = await api(`/api/edmore/ui/state?session_id=${encodeURIComponent(targetSession)}&limit=160`)
  if (targetSession !== sessionId || generation !== stateGeneration) return
  runtime.textContent = `Runtime: ${data.runtime}; Session: ${sessionId}`
  mcpStatus.textContent = `MCP: ${data.nionswift?.ok ? 'online' : 'offline'}`
  mcpStatus.title = data.nionswift?.message || ''
  for (const event of data.events || []) renderUiEvent(event)
  await refreshPendingFromState()
}

providerSelect.addEventListener('change', () => fillProviderForm(selectedProvider()))
loadProvider.addEventListener('click', () => fillProviderForm(selectedProvider()))
newProvider.addEventListener('click', () => {
  providerId.value = 'custom-provider'
  providerName.value = 'custom-provider'
  providerBaseUrl.value = ''
  providerApiKey.value = ''
  providerModel.value = ''
  providerEmbeddingModel.value = ''
  providerStatus.textContent = 'Enter endpoint, API key, and model, then Save.'
})

refreshHarnessTools.addEventListener('click', () => {
  refreshHarnessToolRegistry().catch(error => { harnessTools.textContent = error.message })
})

refreshAgentRoles.addEventListener('click', () => {
  refreshAgentRolesRegistry().catch(error => { agentRoles.textContent = error.message })
})

refreshSkills.addEventListener('click', () => {
  refreshSkillCatalog().catch(error => { skills.textContent = error.message })
})

newProject.addEventListener('click', async () => {
  const defaultCwd = projects.find(project => project.id === currentProjectId)?.cwd || projects[0]?.cwd || ''
  const cwd = window.prompt('Project folder on the Harness host', defaultCwd)
  if (!cwd) return
  const name = window.prompt('Project name', cwd.split('/').filter(Boolean).at(-1) || 'Project') || 'Project'
  try {
    const data = await workspaceApi('/projects', {
      method: 'POST',
      body: JSON.stringify({ name, cwd }),
    })
    projects = [data.project, ...projects.filter(project => project.id !== data.project.id)]
    currentProjectId = data.project.id
    localStorage.setItem('edmore-current-project-id', currentProjectId)
    renderProjectList()
    await loadConversations()
  } catch (error) {
    addMessage('gui', error.message)
  }
})

newConversation.addEventListener('click', async () => {
  if (!currentProjectId) {
    renderConversationList()
    showProcess('Select or create a project first')
    return
  }
  try {
    const conversation = await createConversation()
    await selectConversation(conversation)
    showProcess('Created new conversation', conversation.session_id)
  } catch (error) {
    showProcess('Could not create conversation', error.message)
  }
})

deleteConversation.addEventListener('click', async () => {
  try {
    await deleteCurrentConversation()
  } catch (error) {
    showProcess('Could not delete conversation', error.message)
  }
})

deleteProject.addEventListener('click', async () => {
  try {
    await deleteCurrentProject()
  } catch (error) {
    showProcess('Could not delete project', error.message)
  }
})

document.querySelector('#providerForm').addEventListener('submit', async (event) => {
  event.preventDefault()
  try {
    await api('/api/edmore/llm/providers', {
      method: 'POST',
      body: JSON.stringify({
        id: providerId.value,
        displayName: providerName.value || providerId.value,
        baseURL: providerBaseUrl.value,
        model: providerModel.value,
        embeddingModel: providerEmbeddingModel.value,
        apiKey: providerApiKey.value,
      }),
    })
    await api('/api/edmore/llm/active', {
      method: 'POST',
      body: JSON.stringify({ provider: providerId.value }),
    })
    await refreshProviders()
    showProcess(`Saved '${providerId.value}'`)
  } catch (error) {
    providerStatus.textContent = `Save failed: ${error.message}`
  }
})

selectProvider.addEventListener('click', async () => {
  await api('/api/edmore/llm/active', {
    method: 'POST',
    body: JSON.stringify({ provider: providerSelect.value }),
  })
  await refreshProviders()
})

document.querySelector('#triggerForm').addEventListener('submit', async (event) => {
  event.preventDefault()
  const prompt = promptInput.value.trim()
  if (!prompt) return
  if (!workflowAvailable && (/^[\\/]plan(?:\s+|$)/i.test(prompt) || /^enable workflow mode[.!]?$/i.test(prompt))) {
    showProcess('Workflow mode is unavailable', 'Enable the Judge plugin first. This request was not sent.')
    return
  }
  const requestedPlanMode = planMode
  if (!currentConversationId && workspaceLoaded) {
    if (!currentProjectId) { showProcess('Select or create a project first'); return }
    try { await selectConversation(await createConversation()) }
    catch (error) { showProcess('Could not create conversation', error.message); return }
  }
  setPlanMode(requestedPlanMode)
  promptInput.value = ''
  promptInput.placeholder = prompt
  await touchConversation({ title: prompt, last_message_preview: prompt })
  const sourceDraftId = requestedPlanMode ? sessionStorage.getItem(`edmore-source-draft:${sessionId}`) : null
  await sendAction('trigger', '/api/edmore/actions/trigger', { prompt, session_id: sessionId, plan_mode: requestedPlanMode,
    ...(sourceDraftId ? { source_draft_id: sourceDraftId } : {}) })
})

cancelWorkflow.addEventListener('click', async () => {
  const targetSession = sessionId
  cancelWorkflow.disabled = true
  try {
    const result = await api('/api/edmore/actions/cancel-workflow', {
      method: 'POST', body: JSON.stringify({ session_id: targetSession }),
    })
    if (targetSession !== sessionId) return
    clearPlanSection()
    setPausedWorkflow(null)
    setSubplanProposal(null)
    settleProcess('Workflow cancelled')
    await refreshPendingFromState()
    addMessage('gui', result.hardware_stop_verified
      ? 'Workflow cancelled: routing, planning, queued execution and pending plans cleared. Chat history retained.'
      : 'Workflow cancelled. A tool may still be operating: verify hardware has stopped before releasing its reservation. Do not retry yet.')
  } catch (error) {
    if (targetSession === sessionId) addMessage('gui', `Could not cancel workflow: ${error.message}`)
  } finally { cancelWorkflow.disabled = false }
})

stopGeneration.addEventListener('click', async () => {
  const targetSession = sessionId
  stopGeneration.disabled = true
  try {
    const result = await sendAction('cancel', '/api/edmore/actions/cancel', { session_id: targetSession })
    if (targetSession !== sessionId) return
    const count = Number(result.cancelled) || 0
    settleProcess(count ? 'Response stopped' : 'Nothing running')
    addMessage('gui', count
      ? `Stopped ${count} active or queued task${count === 1 ? '' : 's'}. This session and its history are still available.`
      : 'No active response was found. This session is unchanged.')
  } catch (error) {
    if (targetSession === sessionId) {
      addMessage('gui', `Could not stop the response: ${error.message}`)
      stopGeneration.disabled = false
    }
  }
})

approve.addEventListener('click', async () => {
  if (temporaryDraft?.dirty && temporaryDraft.id === pendingWorkflowId) return
  if ((planningProposalPending || subplanProposalPending) && !pendingWorkflowId) {
    await sendAction('proposal-approve', '/api/edmore/actions/trigger', { prompt: 'approve', session_id: sessionId })
    return
  }
  await sendAction('approve', '/api/edmore/actions/approve', { workflow_id: pendingWorkflowId, session_id: sessionId })
})

reject.addEventListener('click', async () => {
  if ((planningProposalPending || subplanProposalPending) && !pendingWorkflowId) {
    await sendAction('proposal-reject', '/api/edmore/actions/trigger', { prompt: 'reject', session_id: sessionId })
    return
  }
  await sendAction('reject', '/api/edmore/actions/reject', { workflow_id: pendingWorkflowId, reason: 'Rejected in validation UI', session_id: sessionId })
})

confirmWorkflow.addEventListener('click', async () => {
  if (recoveryChoice) return
  if (!pausedWorkflowId) return
  await sendAction('resume', '/api/edmore/actions/resume', { workflow_id: pausedWorkflowId, prompt: 'confirm', session_id: sessionId, ...(confirmationContext ? { confirmation_context: confirmationContext } : {}) })
})

pending.addEventListener('click', async event => {
  if (event.target.closest('#saveTemporaryPlan')) {
    const error = pending.querySelector('#temporaryPlanError')
    try {
      const draft = JSON.parse(pending.querySelector('#temporaryPlanJson').value)
      const result = await sendAction('edit-plan', '/api/edmore/actions/edit-plan', { workflow_id: pendingWorkflowId, session_id: sessionId, draft })
      if (result.plan) setPending(result.plan)
    } catch (e) { if (error) error.textContent = e.message }
    return
  }
  const button = event.target.closest('[data-recovery-version]')
  if (!button || !recoveryChoice || button.dataset.recoveryVersion !== recoveryChoice.version) return
  const selected = pending.querySelector('#recoveryAction')?.value
  if (!selected || (selected !== 'retry_check' && !recoveryChoice.options.some(option => option.id === selected))) return
  button.disabled = true
  try {
    await sendAction('resume', '/api/edmore/actions/resume', { workflow_id: pausedWorkflowId, prompt: selected, session_id: sessionId,
      confirmation_context: { workflow_id: recoveryChoice.workflow_id, step_id: recoveryChoice.step_id, version: recoveryChoice.version } })
  } finally { button.disabled = false }
})

pending.addEventListener('input', event => {
  if (event.target.id !== 'temporaryPlanJson') return
  temporaryDraft = { id: pendingWorkflowId, text: event.target.value, dirty: true }
  updatePlanActionButtons()
})

function startUiStream() {
  if (uiSource) uiSource.close()
  uiSource = new EventSource(`/api/edmore/ui/stream?session_id=${encodeURIComponent(sessionId)}`)
  uiSource.onmessage = (message) => renderUiEvent(JSON.parse(message.data))
  uiSource.onerror = () => { runtime.textContent = `Runtime: UI stream disconnected; Session: ${sessionId}` }
}

Promise.allSettled([
  extensions.refresh(),
  refreshCapabilities(),
  refreshState(),
  refreshProviders(),
  refreshHarnessToolRegistry(),
  refreshAgentRolesRegistry(),
  refreshSkillCatalog(),
]).then(results => {
  for (const result of results) {
    if (result.status === 'rejected') addMessage('gui', result.reason?.message || String(result.reason))
  }
})
setInterval(() => {
  refreshCapabilities().catch(() => {})
  refreshState().catch(() => {})
  refreshHarnessToolRegistry().catch(() => {})
  refreshAgentRolesRegistry().catch(() => {})
  refreshSkillCatalog().catch(() => {})
}, 3000)
