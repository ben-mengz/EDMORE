import test from 'node:test'
import assert from 'node:assert/strict'
import { featurePackages, loadFeatures, modelProviderDefinitions, checkPackageDependencies } from '../src/index.mjs'
import { fileURLToPath } from 'node:url'

const names = ['wiki', 'remote', 'hu', 'bonsai', 'strata'].map(id => `@edmore/plugin-${id}`)
test('explicit installation selection excludes Tango without suppressing missing dependencies', async () => {
  assert.deepEqual(featurePackages({ EDMORE_FEATURE_PACKAGES: JSON.stringify(names) }), names)
  assert.throws(() => featurePackages({ EDMORE_FEATURE_PACKAGES: '["unknown"]' }))
  assert.throws(() => featurePackages({ EDMORE_FEATURE_PACKAGES: JSON.stringify([names[0], names[0]]) }))
  const features = await loadFeatures({ configuration: null, packages: names })
  assert.deepEqual(features.map(f => f.id), ['wiki', 'remote', 'hu', 'bonsai', 'strata'])
  const models = await modelProviderDefinitions({ configuration: null, packages: names })
  assert.deepEqual(models.map(p => [p.id, p.required, p.concurrency]), [['llm3-hu', true, 4], ['bonsai-local', true, 1], ['strata-local', false, 1]])
  for (const name of names) await checkPackageDependencies(fileURLToPath(new URL(`../../${name.split('/')[1]}/plugin.json`, import.meta.url)))
  await assert.rejects(loadFeatures({ configuration: null, packages: ['@edmore/missing-feature'] }))
})
