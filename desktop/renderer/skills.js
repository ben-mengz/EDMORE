const words = {
  en: { skills: 'Skills', new: 'New Skill', refresh: 'Refresh', search: 'Search skills', builtin: 'Built-in', custom: 'Custom', copy: 'Duplicate', save: 'Save Skill', name: 'Name', description: 'Description', id: 'Skill ID', steps: 'Steps', add: 'Add Step', tool: 'MCP Tool', parameters: 'Parameters', fixed: 'Fixed value', ask: 'Ask at runtime', result: 'Previous result', confirm: 'Confirm before this step', question: 'Confirmation question', output: 'Expected output', success: 'On success', failure: 'On failure', next: 'Next step / finish', pause: 'Pause for review', instructions: 'Skill instructions', empty: 'No skills found', pick: 'Select a skill', saved: 'Saved. Applies to new plans; approved plans are unchanged.', offline: 'MCP schemas unavailable. Existing skills remain visible.', connected: 'MCP tools available', unsaved: 'Unsaved changes', discard: 'Discard unsaved changes?', up: 'Move up', down: 'Move down', remove: 'Remove step', readonly: 'Read-only', working: 'Loading...', noSteps: 'No steps', parameter: 'Add parameter', parameterName: 'Parameter name', schema: 'Schema', unavailable: 'Unavailable', reference: 'Included skill', invalid: 'Invalid value', removeParameter: 'Remove parameter', inherited: 'Review inherited skill instructions before saving.', required: 'Required', none: 'Choose a tool' },
  zh: { skills: '技能', new: '新建技能', refresh: '刷新', search: '搜索技能', builtin: '内置', custom: '自定义', copy: '创建副本', save: '保存技能', name: '名称', description: '描述', id: '技能 ID', steps: '步骤', add: '添加步骤', tool: 'MCP 工具', parameters: '参数', fixed: '固定值', ask: '运行时询问', result: '前一步结果', confirm: '执行此步骤前确认', question: '确认内容', output: '预期输出', success: '成功后', failure: '失败后', next: '下一步 / 完成', pause: '暂停等待处理', instructions: '技能说明', empty: '没有匹配的技能', pick: '选择一个技能', saved: '已保存。应用于新计划，不改变已批准的计划。', offline: 'MCP 参数定义暂不可用，仍可查看已有技能。', connected: 'MCP 工具可用', unsaved: '有未保存的修改', discard: '放弃未保存的修改？', up: '上移', down: '下移', remove: '删除步骤', readonly: '只读', working: '加载中…', noSteps: '尚无步骤', parameter: '添加参数', parameterName: '参数名称', schema: '参数定义', unavailable: '不可用', reference: '包含技能', invalid: '值格式错误', removeParameter: '删除参数', inherited: '保存前请检查继承的技能说明。', required: '必填', none: '选择工具' },
}
Object.assign(words.en, { workflow: 'Workflow', support: 'Support', categories: 'Skill categories', newWorkflow: 'Add Workflow', newSupport: 'Add Support', importSupport: 'Import SKILL.md', supportInstructions: 'Instructions (Markdown)', supportSaved: 'Saved.', newWorkflowTitle: 'New workflow', newSupportTitle: 'New support skill' })
Object.assign(words.zh, { workflow: '工作流', support: '辅助技能', categories: '技能分类', newWorkflow: '添加工作流', newSupport: '添加辅助技能', importSupport: '导入 SKILL.md', supportInstructions: '说明（Markdown）', supportSaved: '已保存。', newWorkflowTitle: '新建工作流', newSupportTitle: '新建辅助技能' })
let lang = 'en', rows = [], tools = [], selected, draft, dirty = false, loading = false, notice = '', online = false, query = '', category = 'workflow'
const root = document.getElementById('view-skills')
const t = key => words[lang][key] || key
const label = (en, zh) => lang === 'zh' ? zh : en
const el = (tag, text, cls) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (cls) node.className = cls; return node }
function button(text, action, title) { const node = el('button', text); node.type = 'button'; node.addEventListener('click', action); if (title) { node.title = title; node.ariaLabel = title; node.className = 'skill-icon' } return node }
function field(label, input) { const node = el('label'); input.ariaLabel = label; node.append(el('span', label), input); return node }
function input(value, change, multiline = false) { const node = el(multiline ? 'textarea' : 'input'); node.value = value ?? ''; if (multiline) node.rows = 3; node.addEventListener('input', () => { change(node.value); markDirty() }); return node }
function select(options, value, change) { const node = el('select'); for (const [id, name] of options) { const option = el('option', name); option.value = id; node.append(option) } node.value = value; node.addEventListener('change', () => { change(node.value); markDirty() }); return node }
function markDirty() { dirty = true; const status = root.querySelector('.skill-edit-status'); if (status) status.textContent = t('unsaved') }
function canLeave() { return !dirty || window.confirm(t('discard')) }
const blankStep = tool => ({ tool: tool || '', parameters: {}, confirm: false, confirmation: '', expected_output: '', on_success: 'next', on_failure: 'pause' })
const categoryOf = skill => skill.category || (skill.kind === 'knowledge' ? 'support' : 'workflow')
function expandedSteps(skill, seen = new Set()) {
  if (seen.has(skill.id)) return []
  const nextSeen = new Set([...seen, skill.id])
  if (skill.steps) return structuredClone(skill.steps)
  if (skill.references?.length) return skill.references.flatMap(id => { const child = rows.find(row => row.id === id); return child ? expandedSteps(child, nextSeen) : [] })
  return (skill.ordered_tools || skill.required_tools || []).map(blankStep)
}
function choose(row) { if (!canLeave()) return; selected = row.id; draft = structuredClone(row); category = categoryOf(row); dirty = false; notice = ''; render() }
function chooseCategory(value) {
  if (value === category || !canLeave()) return
  category = value; dirty = false; notice = ''; query = ''
  const first = rows.find(row => categoryOf(row) === category)
  draft = first ? structuredClone(first) : null; selected = first?.id ?? null
  render()
}
function create(copy) {
  if (!canLeave()) return
  const source = copy ? draft : null
  draft = { id: category === 'workflow' ? `custom_${Date.now().toString(36)}` : `support-${Date.now().toString(36)}`, name: source ? `${source.name} (copy)` : '', description: source?.description || '', source: 'custom', category,
    steps: category === 'workflow' ? source ? expandedSteps(source) : [blankStep()] : [],
    ...(category === 'support' ? { content: source?.content || '', instructions: source?.instructions || '' } : { inherited_instructions: source?.instructions || '' }) }
  selected = null; dirty = true; notice = source ? 'inherited' : ''; render()
}
async function importSupport(file) {
  if (!file || !canLeave()) return
  loading = true; notice = ''; render()
  try {
    if (file.size > 800000) throw new Error(label('SKILL.md is too large.', 'SKILL.md 文件过大。'))
    draft = await window.edmore.skills('parse-support', { instructions: await file.text() })
    category = 'support'; selected = null; dirty = true
  } catch (error) { notice = error.message }
  finally { loading = false; render() }
}
async function load() {
  if (loading) return
  loading = true; render()
  try {
    const result = await window.edmore.skills('list'); rows = result.rows
    if (result.warnings?.length) notice = `Unreadable skills: ${result.warnings.join(', ')}`
    const first = rows.find(row => categoryOf(row) === category)
    if (!draft && first) { draft = structuredClone(first); selected = draft.id }
  } catch (error) { notice = error.message }
  finally { loading = false; render() }
  try { tools = await window.edmore.skills('tools'); online = true } catch { online = false; tools = [] }
  if (category === 'workflow') render()
}
async function save() {
  const form = root.querySelector('form')
  if (!form.reportValidity()) return
  loading = true; render()
  try {
    draft = await window.edmore.skills('save', draft); selected = draft.id; dirty = false
    rows = (await window.edmore.skills('list')).rows; notice = category === 'support' ? 'supportSaved' : 'saved'
  } catch (error) { notice = error.message }
  finally { loading = false; render() }
}
function renderList(list) {
  const filtered = rows.filter(row => categoryOf(row) === category && `${row.name} ${row.id} ${row.description}`.toLowerCase().includes(query.toLowerCase()))
  list.replaceChildren(...filtered.map(row => {
    const item = button('', () => choose(row)); item.className = 'skill-list-item'; item.setAttribute('aria-pressed', String(row.id === selected))
    item.append(el('strong', row.name), el('small', `${t(row.source)} · ${category === 'workflow' ? `${expandedSteps(row).length} ${t('steps')}` : t('support')}`))
    return item
  }))
  if (!filtered.length) list.append(el('p', t('empty')))
}
function parameterEditor(step, container) {
  const schema = tools.find(tool => tool.id === step.tool)?.inputSchema || {}
  const names = [...new Set([...Object.keys(schema.properties || {}), ...Object.keys(step.parameters)])]
  for (const name of names) {
    const spec = schema.properties?.[name] || {}, binding = step.parameters[name]
    const row = el('div', undefined, 'skill-parameter')
    const enabled = el('input'); enabled.type = 'checkbox'; enabled.checked = Boolean(binding); enabled.ariaLabel = name
    enabled.addEventListener('change', () => { if (enabled.checked) step.parameters[name] = { mode: 'ask' }; else delete step.parameters[name]; markDirty(); render() })
    const heading = el('label', undefined, 'skill-check'); heading.append(enabled, el('span', `${name}${schema.required?.includes(name) ? ' *' : ''}`)); heading.title = spec.description || ''
    row.append(heading)
    if (binding) {
      row.append(select(['fixed', 'default', 'ask', 'result', 'tool_default'].map(mode => [mode, mode === 'tool_default' ? label('Tool / UI default', '工具 / 界面默认值') : mode === 'default' ? label('User-overridable default', '用户可覆盖默认值') : t(mode)]), binding.mode, mode => { binding.mode = mode; delete binding.value; render() }))
      if (['fixed', 'default', 'result'].includes(binding.mode)) {
        let control
        if (['fixed', 'default'].includes(binding.mode) && spec.enum) {
          control = select([['', ''], ...spec.enum.map((v, i) => [String(i), String(v)])], binding.value === undefined ? '' : String(spec.enum.indexOf(binding.value)), v => { binding.value = spec.enum[Number(v)] })
        } else if (['fixed', 'default'].includes(binding.mode) && spec.type === 'boolean') {
          control = select([['', ''], ['true', 'true'], ['false', 'false']], binding.value === undefined ? '' : String(binding.value), v => { binding.value = v === 'true' })
        } else {
          const structured = ['fixed', 'default'].includes(binding.mode) && (!spec.type || ['object', 'array'].includes(spec.type))
          control = input(structured ? JSON.stringify(binding.value ?? null) : binding.value, v => {
            try {
              binding.value = structured ? JSON.parse(v) : ['number', 'integer'].includes(spec.type) && ['fixed', 'default'].includes(binding.mode) ? Number(v) : v
              control.setCustomValidity('')
            } catch { control.setCustomValidity(t('invalid')) }
          }, structured)
          if (binding.mode === 'result') control.placeholder = '{{tool.field}}'
          else if (['number', 'integer'].includes(spec.type)) { control.type = 'number'; control.step = spec.type === 'integer' ? '1' : 'any'; if (spec.minimum !== undefined) control.min = spec.minimum; if (spec.maximum !== undefined) control.max = spec.maximum }
        }
        control.required = true; control.ariaLabel = name; row.append(control)
      }
    }
    const annotation = el('small', [spec.type || (spec.anyOf ? spec.anyOf.map(item => item.type).join(' / ') : ''), binding?.unit, binding?.description || spec.description].filter(Boolean).join(' · ')); annotation.className = 'skill-parameter-note'; row.append(annotation)
    container.append(row)
  }
  if (!online || schema.additionalProperties) {
    const addRow = el('div', undefined, 'actions'), name = el('input'); name.placeholder = t('parameterName'); name.ariaLabel = t('parameterName')
    addRow.append(name, button('+', () => { if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name.value)) { step.parameters[name.value] = { mode: 'ask' }; markDirty(); render() } }, t('parameter'))); container.append(addRow)
  }
}
function render() {
  root.replaceChildren()
  root.dataset.category = category
  const heading = el('div', undefined, 'section-title'); heading.append(el('h1', t('skills')))
  const actions = el('div', undefined, 'actions'); actions.append(button(t('refresh'), () => { if (canLeave()) { dirty = false; draft = null; void load() } }))
  if (category === 'support') {
    const file = el('input'); file.type = 'file'; file.accept = '.md,text/markdown,text/plain'; file.hidden = true; file.ariaLabel = t('importSupport')
    file.addEventListener('change', () => { void importSupport(file.files[0]) })
    actions.append(file, button(t('importSupport'), () => file.click()))
  }
  actions.append(button(t(category === 'workflow' ? 'newWorkflow' : 'newSupport'), () => create(false)))
  actions.querySelectorAll('button').forEach(node => { node.disabled = loading })
  heading.append(actions); root.append(heading)
  const tabs = el('div', undefined, 'skill-categories'); tabs.setAttribute('role', 'tablist'); tabs.ariaLabel = t('categories')
  for (const value of ['workflow', 'support']) {
    const tab = button(t(value), () => chooseCategory(value)); tab.id = `skill-category-${value}`; tab.setAttribute('role', 'tab'); tab.ariaLabel = t(value)
    tab.setAttribute('aria-selected', String(category === value)); tab.setAttribute('aria-controls', 'skill-category-panel'); tab.tabIndex = category === value ? 0 : -1; tab.disabled = loading
    const count = el('span', String(rows.filter(row => categoryOf(row) === value).length), 'skill-category-count'); count.setAttribute('aria-hidden', 'true'); tab.append(count)
    tab.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
      event.preventDefault(); chooseCategory(event.key === 'Home' ? 'workflow' : event.key === 'End' ? 'support' : category === 'workflow' ? 'support' : 'workflow')
      document.getElementById(`skill-category-${category}`).focus()
    })
    tabs.append(tab)
  }
  root.append(tabs)
  if (category === 'workflow' || loading) { const status = el('p', loading ? t('working') : online ? `${tools.length} ${t('connected')}` : t('offline'), 'skill-connection'); status.setAttribute('role', 'status'); root.append(status) }
  if (notice) { const message = el('p', t(notice), 'skill-notice'); message.setAttribute('role', 'status'); root.append(message) }
  const layout = el('div', undefined, 'skills-layout'), sidebar = el('aside', undefined, 'skills-sidebar'), search = el('input'); search.placeholder = t('search'); search.ariaLabel = t('search'); search.value = query
  layout.id = 'skill-category-panel'; layout.setAttribute('role', 'tabpanel'); layout.setAttribute('aria-labelledby', `skill-category-${category}`)
  const list = el('div', undefined, 'skill-list'); search.addEventListener('input', () => { query = search.value; renderList(list) }); sidebar.append(search, list); renderList(list); layout.append(sidebar)
  const editor = el('div', undefined, 'skill-editor'); layout.append(editor); root.append(layout)
  if (!draft) { editor.append(el('p', t('pick'))); return }
  const readonly = draft.source === 'builtin'
  const toolbar = el('div', undefined, 'section-title'); toolbar.append(el('h2', draft.name || t(category === 'workflow' ? 'newWorkflowTitle' : 'newSupportTitle')))
  toolbar.append(button(t('copy'), () => create(true))); editor.append(toolbar)
  const editStatus = el('p', dirty ? t('unsaved') : readonly ? `${t('builtin')} · ${t('readonly')}` : t('custom'), 'skill-edit-status'); editor.append(editStatus)
  const form = el('form'); form.addEventListener('submit', event => { event.preventDefault(); void save() }); editor.append(form)
  const metadata = el('div', undefined, 'fields')
  for (const key of ['id', 'name']) { const control = input(draft[key], v => { draft[key] = v }); control.required = true; control.maxLength = key === 'id' ? 64 : 160; control.disabled = readonly || (key === 'id' && selected !== null); metadata.append(field(t(key), control)) }
  const description = input(draft.description, v => { draft.description = v }, true); description.required = true; description.disabled = readonly; form.append(metadata, field(t('description'), description))
  description.maxLength = category === 'support' ? 1024 : 4000
  if (category === 'support') {
    const content = input(draft.content || '', value => { draft.content = value }, true)
    content.rows = 20; content.className = 'skill-support-content'; content.required = true; content.maxLength = 200000; content.disabled = readonly; content.spellcheck = false
    form.append(field(t('supportInstructions'), content))
    appendSave(form, readonly)
    return
  }
  const steps = readonly ? expandedSteps(draft) : draft.steps
  const stepsTitle = el('div', undefined, 'section-title'); stepsTitle.append(el('h2', `${t('steps')} (${steps.length})`)); if (!readonly) stepsTitle.append(button(t('add'), () => { steps.push(blankStep()); markDirty(); render() })); form.append(stepsTitle)
  const timeline = el('div', undefined, 'skill-timeline'); form.append(timeline)
  steps.forEach((step, index) => {
    const block = el('details', undefined, 'skill-step'); block.open = !readonly || index === 0; const summary = el('summary'); summary.append(el('span', String(index + 1), 'skill-step-number'), el('span', step.title || step.tool || t('none'))); block.append(summary)
    const content = el('fieldset', undefined, 'skill-step-content'); content.disabled = readonly; block.append(content); timeline.append(block)
    content.append(field(label('Step name', '步骤名称'), input(step.title || step.tool, v => { step.title = v })), field(label('Purpose', '用途'), input(step.purpose || '', v => { step.purpose = v }, true)))
    const ordering = el('div', undefined, 'skill-order')
    const up = button('↑', () => { [steps[index - 1], steps[index]] = [steps[index], steps[index - 1]]; markDirty(); render() }, t('up')); up.disabled = index === 0
    const down = button('↓', () => { [steps[index], steps[index + 1]] = [steps[index + 1], steps[index]]; markDirty(); render() }, t('down')); down.disabled = index === steps.length - 1
    ordering.append(up, down, button('−', () => { steps.splice(index, 1); markDirty(); render() }, t('remove'))); if (!readonly) content.append(ordering)
    const known = [...new Set([...tools.map(tool => tool.id), ...rows.flatMap(row => row.ordered_tools || []), step.tool].filter(Boolean))]
    const toolSelect = select([['', t('none')], ...known.map(id => [id, `${id}${online && !tools.some(tool => tool.id === id) ? ` (${t('unavailable')})` : ''}`])], step.tool, value => { step.tool = value; step.parameters = {}; render() }); toolSelect.required = true; content.append(field(t('tool'), toolSelect))
    const parameters = el('div', undefined, 'skill-parameters'); parameters.append(el('h3', t('parameters'))); parameterEditor(step, parameters); content.append(parameters)
    const confirm = el('input'); confirm.type = 'checkbox'; confirm.checked = step.confirm; confirm.disabled = Boolean(step.confirmation_required); confirm.addEventListener('change', () => { step.confirm = confirm.checked; markDirty(); render() }); const check = el('label', undefined, 'skill-check'); check.append(confirm, el('span', t('confirm') + (step.confirmation_required ? label(' (required)', '（强制）') : ''))); content.append(check)
    if (step.confirm) { const question = input(step.confirmation, v => { step.confirmation = v }); question.required = true; content.append(field(t('question'), question)) }
    content.append(field(t('output'), input(step.expected_output, v => { step.expected_output = v })))
    step.completion ||= { type: 'tool_success' }
    content.append(field(label('Completion condition', '完成条件'), select([['tool_success', label('Tool returns success', '工具返回成功')], ['field_present', label('Result field exists', '结果字段存在')], ['field_equals', label('Result field equals', '结果字段等于')]], step.completion.type, v => { step.completion = { type: v }; render() })))
    if (step.completion.type !== 'tool_success') {
      const path = input(step.completion.field, v => { step.completion.field = v }); path.required = true; content.append(field(label('Structured result field', '结构化结果字段'), path))
      if (step.completion.type === 'field_equals') { const value = input(JSON.stringify(step.completion.value ?? null), v => { try { step.completion.value = JSON.parse(v); value.setCustomValidity('') } catch { value.setCustomValidity(t('invalid')) } }); content.append(field(label('Expected value (JSON)', '目标值（JSON）'), value)) }
    }
    if (step.failure_guidance || !readonly) content.append(field(label('Recovery guidance', '失败处理说明'), input(step.failure_guidance || '', v => { step.failure_guidance = v }, true)))
    const policy = el('div', undefined, 'fields'); policy.append(field(t('success'), select([['next', t('next')]], 'next', () => {})), field(t('failure'), select([['pause', t('pause')]], 'pause', () => {}))); content.append(policy)
  })
  if (draft.instructions || draft.inherited_instructions) { const docs = el('details'); docs.append(el('summary', t('instructions')), el('pre', draft.instructions || draft.inherited_instructions)); form.append(docs) }
  appendSave(form, readonly)
}
function appendSave(form, readonly) {
  if (!readonly) { const saveButton = el('button', t('save')); saveButton.type = 'submit'; saveButton.className = 'skill-save'; form.append(saveButton) }
  if (loading) root.querySelectorAll('button').forEach(node => { node.disabled = true })
}
export const skillsView = {
  open: async () => { if (!rows.length) await load(); else render() },
  translate: value => { lang = value; document.querySelector('[data-tab="skills"]').textContent = t('skills'); if (root.children.length) render() },
}
