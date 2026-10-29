import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, symlink, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { SkillManager } from '../skills.mjs'

const fixture = () => ({ id: 'custom_test', name: 'Test acquisition', description: 'An isolated test template.', steps: [{ tool: 'agent_sem.wait', parameters: { seconds: { mode: 'fixed', value: 2 } }, confirm: true, confirmation: 'Confirm readiness', expected_output: 'Wait completed', on_success: 'next', on_failure: 'pause' }] })
const supportFixture = () => ({ category: 'support', id: 'dose-notes', name: 'Dose notes', description: 'Reason about electron dose.', content: '# Dose notes\n\nUse the measured beam current.\n\n```python\ndose = current * time\n```' })
test('lists built-ins and round-trips custom skills without modifying built-ins', async () => {
  const home = await mkdtemp(join(tmpdir(), 'edmore-skills-'))
  try {
    const manager = new SkillManager({ root: resolve('../client') }, home)
    assert.ok((await manager.list()).rows.some(row => row.id === 'ptychography_on_sem' && row.source === 'builtin'))
    await manager.save(fixture())
    const loaded = (await manager.list()).rows.find(row => row.id === 'custom_test')
    assert.equal(loaded.steps[0].parameters.seconds.value, 2)
    assert.equal(loaded.source, 'custom')
    assert.equal(loaded.category, 'workflow')
    assert.match(loaded.instructions, /Prepare a PlanReview/)
    const changed = fixture(); changed.steps[0].parameters.seconds.value = 3
    await manager.save(changed)
    assert.equal((await manager.list()).rows.find(row => row.id === 'custom_test').steps[0].parameters.seconds.value, 3)
    await assert.rejects(readFile(join(home, 'edmore/skills/custom-test/manifest.json')), /ENOENT/)
    assert.match(await readFile(join(home, 'edmore/skills/custom-test/SKILL.md'), 'utf8'), /references\/workflow.yaml/)
  } finally { await rm(home, { recursive: true, force: true }) }
})

test('saves and edits broad support Markdown without steps or a workflow resource', async () => {
  const home = await mkdtemp(join(tmpdir(), 'edmore-support-'))
  try {
    const manager = new SkillManager({ root: resolve('../client') }, home)
    const saved = await manager.save(supportFixture())
    assert.equal(saved.category, 'support')
    assert.equal(saved.kind, 'knowledge')
    assert.equal(saved.metadata.edmore.authority, 'support')
    assert.deepEqual(saved.steps, [])
    assert.equal(saved.content.trimEnd(), supportFixture().content)
    const target = join(home, 'edmore/skills/dose-notes')
    await assert.rejects(readFile(join(target, 'references/workflow.yaml')), /ENOENT/)
    await assert.rejects(readFile(join(target, 'manifest.json')), /ENOENT/)
    const updated = await manager.save({ ...saved, content: '# Revised notes\n\nRead references/workflow.yaml only as an example.' })
    assert.match(updated.content, /Revised notes/)
    const again = await manager.save(updated)
    assert.equal(again.content, updated.content)
    const list = await manager.list()
    assert.equal(list.rows.find(row => row.id === 'dose-notes').category, 'support')
    assert.ok(list.rows.some(row => row.category === 'workflow'))
    await assert.rejects(manager.save({ ...supportFixture(), content: '' }), /instructions are required/)
  } finally { await rm(home, { recursive: true, force: true }) }
})

test('imports SKILL.md metadata and preserves invocation settings while saving as support', async () => {
  const home = await mkdtemp(join(tmpdir(), 'edmore-support-import-'))
  try {
    const manager = new SkillManager({ root: resolve('../client') }, home)
    const imported = await manager.parseSupport({ instructions: '---\nname: imported-notes\ndescription: Imported notes\nlicense: MIT\ndisable-model-invocation: true\nuser-invocable: false\nmetadata:\n  author: scientist\n  kind: workflow\n  edmore:\n    authority: workflow\n    workflow: references/workflow.yaml\n---\n# Notes\n\nRead references/workflow.yaml as background.' })
    await assert.rejects(readFile(join(home, 'edmore/skills/imported-notes/SKILL.md')), /ENOENT/)
    const saved = await manager.save(imported)
    assert.equal(saved.category, 'support')
    assert.equal(saved.metadata.author, 'scientist')
    assert.equal(saved.metadata.edmore.authority, 'support')
    assert.equal(saved.metadata.edmore.workflow, undefined)
    const { parseSkillMarkdown } = await import('../../client/skill-format.mjs')
    const { front } = parseSkillMarkdown(saved.instructions)
    assert.equal(front.license, 'MIT')
    assert.equal(front['disable-model-invocation'], true)
    assert.equal(front['user-invocable'], false)
    await assert.rejects(manager.parseSupport({ instructions: '# Missing frontmatter' }), /Invalid SKILL.md/)
    await assert.rejects(manager.parseSupport({ instructions: '---\nname: notes\ndescription: Notes\nuser-invocable: nope\n---\ntext' }), /must be true or false/)
  } finally { await rm(home, { recursive: true, force: true }) }
})

test('protects category boundaries, built-in names and support paths', async () => {
  const home = await mkdtemp(join(tmpdir(), 'edmore-support-paths-'))
  try {
    const manager = new SkillManager({ root: resolve('../client') }, home)
    await manager.save(fixture())
    await assert.rejects(manager.save({ ...supportFixture(), id: 'custom-test' }), /different skill category/)
    await manager.save({ ...supportFixture(), id: 'custom-notes' })
    await assert.rejects(manager.save({ ...fixture(), id: 'custom_notes' }), /different skill category/)
    await assert.rejects(manager.save({ ...supportFixture(), id: 'acquire-4d-stem' }), /read-only/)
    await assert.rejects(manager.save({ ...supportFixture(), id: '../escape' }), /Support skill ID/)
    await symlink(home, join(home, 'edmore/skills/linked-notes'))
    await assert.rejects(manager.save({ ...supportFixture(), id: 'linked-notes' }), /Symbolic/)
    // Even a stray workflow file cannot promote explicitly supporting material.
    const target = join(home, 'edmore/skills/custom-notes/references')
    await mkdir(target)
    await writeFile(join(target, 'workflow.yaml'), 'not a workflow')
    assert.equal((await manager.list()).rows.find(row => row.id === 'custom-notes').category, 'support')
  } finally { await rm(home, { recursive: true, force: true }) }
})
test('rejects traversal, missing gates, unsupported branches and symlink writes', async () => {
  const home = await mkdtemp(join(tmpdir(), 'edmore-skills-'))
  try {
    const manager = new SkillManager({ root: resolve('../client') }, home)
    await assert.rejects(manager.save({ ...fixture(), id: '../escape' }))
    await assert.rejects(manager.save({ ...fixture(), id: 'ptychography' }))
    for (const patch of [{ confirmation: '' }, { on_failure: 'retry' }, { on_success: 'jump' }, { tool: 'invented' }, { parameters: { path: { mode: 'result', value: '../file' } } }]) {
      const skill = fixture(); Object.assign(skill.steps[0], patch); await assert.rejects(manager.save(skill))
    }
    await manager.save(fixture())
    await symlink(home, join(home, 'edmore/skills/custom_link'))
    await assert.rejects(manager.save({ ...fixture(), id: 'custom_link' }), /Symbolic/)
  } finally { await rm(home, { recursive: true, force: true }) }
})

test('saves named branches and rejects unbounded loops', async () => {
  const home = await mkdtemp(join(tmpdir(), 'edmore-skills-loop-'))
  try {
    const manager = new SkillManager({ root: resolve('../client') }, home)
    const loop = fixture()
    loop.steps = [
      { ...loop.steps[0], id: 'measure', confirm: false, confirmation: '', on_success: 'complete', on_failure: 'adjust' },
      { ...loop.steps[0], id: 'adjust', confirm: false, confirmation: '', on_success: 'measure', on_failure: 'pause' },
    ]
    await assert.rejects(manager.save(loop), /requires max_visits/)
    loop.steps[1].max_visits = 4
    const saved = await manager.save(loop)
    assert.equal(saved.steps[0].on_failure, 'adjust')
    assert.equal(saved.steps[1].on_success, 'measure')
    assert.equal(saved.steps[1].max_visits, 4)
  } finally { await rm(home, { recursive: true, force: true }) }
})

test('round-trips an explicit Jev semantic judgment criterion', async () => {
  const home = await mkdtemp(join(tmpdir(), 'edmore-skills-jev-'))
  try {
    const manager = new SkillManager({ root: resolve('../client') }, home)
    const skill = fixture()
    skill.steps[0].completion = { type: 'semantic_judge', criteria: 'Measured beam-centre distance is at most 0.02 field half-widths.' }
    const saved = await manager.save(skill)
    assert.equal(saved.steps[0].completion.type, 'semantic_judge')
    assert.match(saved.steps[0].completion.criteria, /0\.02/)
  } finally { await rm(home, { recursive: true, force: true }) }
})
