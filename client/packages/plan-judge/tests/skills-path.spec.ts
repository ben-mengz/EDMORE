import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveSkillsRoot } from '../../backend/src/paths.ts'
import { EdmoreWorkflow } from '../src/index.ts'

describe('planning skills after client migration', () => {
  const packageRoot = resolve(import.meta.dirname, '../../backend')

  it('resolves the standalone client layout without an environment override', () => {
    expect(resolveSkillsRoot(packageRoot, '')).toBe(resolve(packageRoot, '../../skills'))
  })

  it('honors the client root used by the native skill registry', () => {
    expect(resolveSkillsRoot(packageRoot, '/tmp/edmore-client')).toBe('/tmp/edmore-client/skills')
  })

  it('loads the actual SEM ptychography planning contracts without calling hardware', async () => {
    const workflow = new EdmoreWorkflow({} as never, {} as never, resolveSkillsRoot(packageRoot, ''))
    const contracts = await (workflow as any).loadSkillContracts()
    expect(contracts.has('ptychography_on_sem')).toBe(true)
    expect(contracts.has('acquire_4d_stem')).toBe(true)
    expect(contracts.has('ptychography')).toBe(true)
  })
})
