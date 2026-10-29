import { expect, it } from 'vitest'
import { encodeWorkflowState, decodeWorkflowState } from '../src/snapshot-codec.ts'
import { builders } from '../../../scripts/build-tem-alignment-workflows.mjs'

it('deduplicates expanded TEM contracts and restores independent exact snapshots', () => {
  const contracts = Object.values(builders).map(build => build().finish())
  // Repeated snapshots also occur in persisted histories of the same contract.
  const original = { version: 1, steps: Array.from({ length: 50 }, () => contracts.flatMap(contract => contract.steps.map(step => ({ skill_snapshot: contract })))).flat() }
  const encoded = encodeWorkflowState(original)
  expect(encoded.length).toBeLessThan(JSON.stringify(original).length / 5)
  const restored = decodeWorkflowState(encoded) as typeof original
  expect(restored).toEqual(original)
  expect(restored.steps[0].skill_snapshot).not.toBe(restored.steps[1].skill_snapshot)
  console.log(`TEM workflow state: ${(JSON.stringify(original).length/1e6).toFixed(1)} MB -> ${(encoded.length/1e6).toFixed(1)} MB`)
})

it('accepts legacy state but rejects missing or altered snapshot entries', () => {
  expect(decodeWorkflowState('{"version":1}')).toEqual({ version: 1 })
  const encoded = JSON.parse(encodeWorkflowState({ version: 1, steps: [{ skill_snapshot: { id: 'a' } }] }))
  const id = Object.keys(encoded.skill_snapshot_table)[0]
  encoded.skill_snapshot_table[id].id = 'tampered'
  expect(() => decodeWorkflowState(JSON.stringify(encoded))).toThrow('integrity')
  delete encoded.skill_snapshot_table[id]
  expect(() => decodeWorkflowState(JSON.stringify(encoded))).toThrow('Missing')
})
