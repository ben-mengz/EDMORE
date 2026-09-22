import readline from 'node:readline'
import { randomUUID } from 'node:crypto'

export const name = 'edmore-tui'
// Mount only in an interactive frontend profile, never in the daemon profile.
export function apply(ctx, config = {}) {
  ctx.effect(() => startTui(config), 'edmore.tui')
}

export const clean = value => String(value ?? '').replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').replace(/\s+/g, ' ').trim()
const width = text => [...text].reduce((n, c) => n + (c.codePointAt(0) > 0x2e7f ? 2 : 1), 0)
export function fit(value, size) {
  let text = ''; let used = 0
  for (const c of clean(value)) { const w = width(c); if (used + w > size) break; text += c; used += w }
  return text + ' '.repeat(Math.max(0, size - used))
}
export function wrap(value, size) {
  const lines = []; let line = ''
  for (const word of clean(value).split(' ')) {
    if (line && width(line + ' ' + word) > size) { lines.push(line); line = '' }
    for (const c of (line ? ' ' : '') + word) {
      if (width(line + c) > size) { lines.push(line); line = '' }
      line += c
    }
  }
  if (line) lines.push(line)
  return lines
}
export function consumeEvent(state, event) {
  if (state.seen.has(event.event_id)) return
  state.seen.add(event.event_id)
  if (state.seen.size > 2000) state.seen.delete(state.seen.values().next().value)
  state.cursor = Math.max(state.cursor, Number(event.cursor) || 0)
  const type = event.type || ''; const p = event.payload || {}
  if (type.endsWith('conversation.user_message') || type.endsWith('conversation.assistant_message')) {
    state.messages.push({ role: type.endsWith('user_message') ? 'YOU' : 'EDMORE', text: p.text || '' })
    state.messages = state.messages.slice(-100)
    state.process = type.endsWith('user_message') ? 'Thinking' : ''
  }
  if (/process\.(started|updated)$/.test(type)) state.process = p.message || p.label || 'Working'
  if (/process\.completed$/.test(type)) state.process = ''
}
export function workflowView(data, session) {
  const w = data.workflow || {}
  const pending = (w.pending || []).find(p => p.session_id === session)
  const paused = (w.paused || []).find(p => p.session_id === session)
  const active = (w.active || []).find(p => p.session_id === session)
  return { plan: pending || active?.plan || paused?.plan, index: active?.next_step_index || 0,
    status: pending ? 'Awaiting approval' : paused ? 'Paused' : active ? 'Running' : 'Idle',
    reason: paused?.state?.reason || '', pending }
}
export function render(state, columns = 120, rows = 36) {
  columns = Math.max(40, columns); rows = Math.max(14, rows)
  const side = columns >= 90 ? Math.min(42, Math.floor(columns * .35)) : 0
  const main = columns - side - (side ? 5 : 4)
  const cyan = '\x1b[36m'; const dim = '\x1b[90m'; const reset = '\x1b[0m'
  const lines = [cyan + '  EDMORE' + reset + ' / Terminal', dim + fit(`  ${state.demo ? 'DEMO - illustrative content' : state.connection}  |  ${state.url}`, columns) + reset,
    dim + fit(`  ${state.title || state.session || 'Select a conversation'}  |  ${state.model || 'Model: backend configuration'}`, columns) + reset, '']
  const chat = state.messages.flatMap(m => [m.role, ...wrap(m.text, main - 2).map(x => '  ' + x), ''])
  const wf = ['WORKFLOW', state.workflow.status, '', ...wrap(state.workflow.plan?.goal || '', side - 2)]
  for (const [i, step] of (state.workflow.plan?.steps || []).entries()) {
    wf.push('', ...wrap(`${i < state.workflow.index ? '[done]' : i === state.workflow.index ? '[ > ]' : '[   ]'} ${i + 1}. ${step.title || step.description || step.tool_name || step.step_id}`, Math.max(20, side - 2)))
  }
  if (state.workflow.reason) wf.push('', ...wrap(state.workflow.reason, Math.max(20, side - 2)))
  const height = rows - 9
  const end = Math.max(0, chat.length - state.scroll)
  const visible = chat.slice(Math.max(0, end - height), end)
  for (let i = 0; i < height; i++) lines.push('  ' + fit(visible[i] || '', main) + (side ? dim + ' | ' + reset + fit(wf[i] || '', side) : ''))
  lines.push(dim + '  ' + '-'.repeat(columns - 4) + reset,
    cyan + '  ' + fit(state.notice || state.process || `Workflow: ${state.workflow.status}`, columns - 4) + reset,
    '  > ' + fit(state.input.slice(-Math.max(10, columns - 7)), columns - 5),
    dim + fit('  /sessions  /open N  /approve  /quit   |   PgUp/PgDn history', columns) + reset)
  return '\x1b[H' + lines.map(x => x + '\x1b[K').join('\r\n') + '\x1b[J'
}

export function startTui({ url = 'http://127.0.0.1:7380', session, demo = false } = {}) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Open this frontend in an interactive terminal.')
  const controller = new AbortController()
  const s = { url, session, demo, title: '', model: '', connection: 'Connecting', cursor: 0, seen: new Set(), messages: [], input: '', scroll: 0, workflow: { status: 'Idle' } }
  let streamController; let stopped = false; let busy = false; let conversations = []; let generation = 0
  const draw = () => { if (!stopped) process.stdout.write(render(s, process.stdout.columns, process.stdout.rows)) }
  const api = async (path, body) => {
    const response = await fetch(url + path, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]),
      ...(body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}) })
    if (!response.ok) throw new Error(`Backend HTTP ${response.status}: ${(await response.text()).slice(0, 160)}`)
    return response.json()
  }
  const refresh = async () => {
    const current = s.session
    const data = await api(`/api/edmore/ui/state?session_id=${encodeURIComponent(current)}&limit=160`)
    if (current !== s.session) return
    for (const event of data.events || []) consumeEvent(s, event)
    s.workflow = workflowView(data, current); s.connection = 'Connected / subscribed'; draw()
  }
  const follow = async token => {
    while (!stopped && token === generation) {
      streamController = new AbortController()
      try {
        const response = await fetch(`${url}/api/edmore/ui/stream?session_id=${encodeURIComponent(s.session)}&after=${s.cursor}`, { signal: AbortSignal.any([controller.signal, streamController.signal]) })
        if (!response.ok) throw new Error(`Stream HTTP ${response.status}`)
        let buffer = ''; const decoder = new TextDecoder()
        for await (const bytes of response.body) {
          if (token !== generation) break
          buffer += decoder.decode(bytes, { stream: true }); buffer = buffer.replace(/\r\n/g, '\n')
          let split
          while ((split = buffer.indexOf('\n\n')) >= 0) {
            const frame = buffer.slice(0, split); buffer = buffer.slice(split + 2)
            const data = frame.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).join('\n')
            if (data) consumeEvent(s, JSON.parse(data))
          }
          draw()
        }
      } catch (e) { if (!stopped && token === generation) { s.connection = 'Reconnecting'; s.notice = e.message; draw() } }
      if (!stopped && token === generation) await new Promise(resolve => setTimeout(resolve, 1500))
    }
  }
  const open = async item => {
    generation++; streamController?.abort(); s.session = item.session_id; s.title = item.title
    s.messages = []; s.seen.clear(); s.cursor = 0; s.scroll = 0; s.notice = ''; s.workflow = { status: 'Idle' }
    await refresh(); void follow(generation)
    try { const m = await api(`/api/edmore/conversation-model?session_id=${encodeURIComponent(s.session)}`); s.model = m.effective?.model || ''; draw() } catch { /* Optional model display. */ }
  }
  const submit = async input => {
    if (input === '/quit') return stop()
    if (demo) { s.notice = 'Demo is read-only. Launch without --demo to connect.'; return }
    if (input === '/sessions') {
      conversations = (await api('/api/edmore-workspace/conversations')).conversations || []
      s.messages.push({ role: 'SESSIONS', text: conversations.map((c, i) => `${i + 1}. ${c.title} (${c.session_id})`).join('\n') }); return
    }
    if (input.startsWith('/open ')) {
      const item = conversations[Number(input.split(' ')[1]) - 1]
      if (!item) throw new Error('Use /sessions, then /open NUMBER.')
      return open(item)
    }
    if (input.startsWith('/') && input !== '/approve') throw new Error('Available: /sessions /open N /approve /quit')
    if (!s.session) throw new Error('Select a conversation with /sessions and /open N.')
    if (input === '/approve' && !s.workflow.pending) throw new Error('No plan is awaiting approval. Use normal conversation input for confirmations.')
    await api('/api/edmore/actions/' + (input === '/approve' ? 'approve' : 'trigger'), {
      action_id: randomUUID(), session_id: s.session,
      ...(input === '/approve' ? { workflow_id: s.workflow.pending.workflow_id } : { prompt: input }) })
    s.notice = ''; s.process = 'Waiting for backend'; await refresh()
  }
  const onKey = (text, key = {}) => {
    if (key.ctrl && key.name === 'c') return stop()
    if (key.name === 'pageup') s.scroll += 8
    else if (key.name === 'pagedown') s.scroll = Math.max(0, s.scroll - 8)
    else if (key.name === 'backspace') s.input = [...s.input].slice(0, -1).join('')
    else if (key.name === 'return') {
      if (busy || !s.input.trim()) return
      const input = s.input.trim(); s.input = ''; s.scroll = 0; busy = true
      void submit(input).catch(e => { s.notice = e.message }).finally(() => { busy = false; draw() })
    } else if (!key.ctrl && !key.meta && text && !text.includes('\x1b')) s.input += text.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ')
    draw()
  }
  const previousRaw = process.stdin.isRaw
  function stop() {
    if (stopped) return
    stopped = true; controller.abort(); streamController?.abort(); clearInterval(timer)
    process.stdin.off('keypress', onKey); process.stdout.off('resize', draw)
    process.off('SIGTERM', stop); process.off('SIGINT', stop)
    process.stdin.setRawMode(previousRaw || false); process.stdin.pause()
    process.stdout.write('\x1b[?25h\x1b[?1049l')
  }
  readline.emitKeypressEvents(process.stdin); process.stdin.setRawMode(true); process.stdin.resume()
  process.stdin.on('keypress', onKey); process.stdout.on('resize', draw)
  process.on('SIGTERM', stop); process.on('SIGINT', stop)
  process.stdout.write('\x1b[?1049h\x1b[?25l')
  const timer = setInterval(() => { if (!demo && s.session) void refresh().catch(e => { s.connection = 'Disconnected'; s.notice = e.message; draw() }) }, 4000)
  if (demo) {
    s.title = 'SEM ptychography'; s.model = 'openai / gpt-5-mini'
    s.messages = [
      { role: 'YOU', text: 'Acquire a 4D-STEM dataset and prepare ptychography reconstruction.' },
      { role: 'EDMORE', text: 'I will acquire the dataset on SEM, prepare reconstruction parameters, and pause at the confirmations required by the workflow.' },
      { role: 'YOU', text: 'Approve the workflow.' },
      { role: 'EDMORE', text: 'BF preview is running and pixel size is synchronized. Please review the ROI in NionSwift, then confirm here or in the instrument UI.' }]
    s.workflow = { status: 'Paused / awaiting ROI confirmation', index: 2, plan: { goal: 'SEM acquisition to ptychography', steps: ['Start BF preview', 'Synchronize pixel size', 'Confirm scan ROI', 'Acquire 4D-STEM dataset', 'Prepare reconstruction', 'Review and submit'].map(title => ({ title })) } }
    draw()
  } else {
    draw()
    void (async () => {
      conversations = (await api('/api/edmore-workspace/conversations')).conversations || []
      const item = session ? conversations.find(c => c.session_id === session) || { session_id: session, title: session } : conversations[0]
      if (item) await open(item)
      else { s.notice = 'No conversations. Create one in WebUI, then /sessions.'; draw() }
    })().catch(e => { s.notice = e.message; s.connection = 'Disconnected'; draw() })
  }
  return stop
}
