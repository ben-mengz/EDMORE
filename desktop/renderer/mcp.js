export function mcpEditor(target, { list, save, language = () => 'en', cloud = false }) {
  target.classList.add('mcp-editor')
  let data = { rows: [], shared: [] }, selected, busy = false
  const t = (en, zh) => language() === 'zh' ? zh : en
  const node = (tag, text, parent = target) => { const el = document.createElement(tag); if (text) el.textContent = text; parent.append(el); return el }
  const heading = node('div'); heading.className = 'section-title'
  const title = node('h2', '', heading)
  const add = node('button', '', heading); add.type = 'button'
  const status = node('p'); status.setAttribute('role', 'status')
  const table = node('table'); const body = node('tbody', '', table)
  const form = node('form'); form.hidden = true
  const field = (label, tag, name, type) => {
    const wrapper = node('label', '', form); const caption = node('span', label, wrapper)
    const el = node(tag, '', wrapper); el.name = name; if (type) el.type = type
    return { el, caption, wrapper }
  }
  const id = field('Name', 'input', 'id'); id.el.required = true; id.el.pattern = '[A-Za-z0-9_-]{1,32}'; id.el.maxLength = 32
  const kind = field('Type', 'select', 'kind')
  for (const [value, label] of [['standard','Standard MCP (FastMCP)'],['edmore','EDMORE multi-agent']]) { const option = node('option', label, kind.el); option.value = value }
  const url = field('URL', 'input', 'url', 'url'); url.el.required = true
  const secrets = field('Headers (JSON)', 'textarea', 'secrets'); secrets.el.rows = 3; secrets.el.autocomplete = 'off'; secrets.el.spellcheck = false
  const enabled = field('Enabled', 'input', 'enabled', 'checkbox'); enabled.wrapper.className = 'check'
  const actions = node('div', '', form); actions.className = 'actions'
  const submit = node('button', '', actions); submit.type = 'submit'
  const remove = node('button', '', actions); remove.type = 'button'
  const cancel = node('button', '', actions); cancel.type = 'button'
  function translate() {
    title.textContent = t('MCP connections', 'MCP 连接'); add.textContent = t('Add connection', '添加连接')
    id.caption.textContent = t('Name', '连接名称'); kind.caption.textContent = t('Type', '类型')
    kind.el.options[0].textContent = t('Standard MCP (FastMCP)', '标准 MCP（FastMCP）')
    kind.el.options[1].textContent = t('EDMORE multi-agent', 'EDMORE 多 Agent 接口')
    secrets.caption.textContent = t('Headers (JSON)', '请求头（JSON）'); enabled.caption.textContent = t('Enabled', '启用')
    submit.textContent = t('Save connection', '保存连接'); remove.textContent = t('Remove', '删除'); cancel.textContent = t('Cancel', '取消')
    for (const field of [id, kind, url, secrets, enabled]) field.el.setAttribute('aria-label', field.caption.textContent)
    render()
  }
  function render() {
    body.replaceChildren()
    for (const row of [...(data.shared || []).map(row => ({ ...row, managed: true })), ...data.rows]) {
      const tr = node('tr', '', body)
      const cell = node('td', '', tr)
      if (row.managed) node('span', row.id, cell)
      else { const button = node('button', row.id, cell); button.type = 'button'; button.disabled = busy; button.onclick = () => edit(row) }
      node('td', row.kind === 'edmore' ? 'EDMORE' : 'MCP', tr)
      node('td', row.shadowed ? t('Name reserved by admin', '名称已被管理员占用') : row.enabled ? t('Enabled', '启用') : t('Disabled', '停用'), tr)
      node('td', row.managed ? t('Administrator managed', '管理员管理') : (row.url || ''), tr)
    }
    if (!body.children.length) node('td', t('No connections', '暂无连接'), node('tr', '', body)).colSpan = 4
  }
  function kindChanged() {
    if (!selected?.id) id.el.value = kind.el.value === 'edmore' ? 'nionswift' : ''
    id.el.readOnly = Boolean(selected?.id) || kind.el.value === 'edmore'
    url.el.placeholder = kind.el.value === 'edmore' ? 'http://127.0.0.1:7300' : 'https://example.org:8000/mcp'
  }
  function edit(row) {
    selected = row; form.reset(); form.hidden = false
    id.el.value = row.id || ''; kind.el.value = row.kind || 'standard'; url.el.value = row.url || ''; enabled.el.checked = row.enabled ?? true
    kind.el.disabled = Boolean(row.id)
    secrets.el.placeholder = row.secretConfigured ? t('Saved; blank keeps existing headers', '已保存；留空保留请求头') : '{}'
    remove.hidden = !row.id || row.source === 'profile'; kindChanged()
  }
  async function run(action) {
    if (busy) return
    busy = true; add.disabled = true; submit.disabled = true; remove.disabled = true; cancel.disabled = true; status.textContent = ''; render()
    try { await action() } catch (error) { status.textContent = error.message }
    finally { busy = false; add.disabled = false; submit.disabled = false; remove.disabled = false; cancel.disabled = false; render() }
  }
  async function open() { await run(async () => { data = await list(); render() }) }
  async function persist(value) {
    data = await save(value); form.hidden = true; selected = undefined; render()
    status.textContent = cloud ? t('Saved. Your Harness will reconnect on the next request.', '已保存，下次请求将重新连接你的 Harness。') : t('Saved. Restart Harness to apply.', '已保存，重启 Harness 生效。')
  }
  form.onsubmit = event => { event.preventDefault(); void run(async () => {
    const value = { id: id.el.value, kind: kind.el.value, url: url.el.value, transport: 'streamable-http', enabled: enabled.el.checked }
    if (secrets.el.value.trim()) value.secrets = JSON.parse(secrets.el.value)
    await persist(value)
  }) }
  remove.onclick = () => { if (selected && confirm(t(`Remove ${selected.id}?`, `删除 ${selected.id}？`))) void run(() => persist({ id: selected.id, remove: true })) }
  add.onclick = () => edit({}); cancel.onclick = () => { form.hidden = true }; kind.el.onchange = kindChanged
  translate()
  return { open, translate }
}
