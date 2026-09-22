import { it, expect, vi } from 'vitest'
import { NionSwiftBridge } from '../../mcp-bridge/src/bridge.ts'

it('reads and caches legacy model resources and tolerates servers without resources', async () => {
  const bridge = new NionSwiftBridge({} as never, 'http://unused')
  const request = vi.fn(async ({ method, params }) => method === 'resources/list'
    ? { resources: ['model', 'reasoning'].map(scheme => ({ uri: `${scheme}://sem` })) }
    : { contents: [{ text: params.uri.startsWith('model:') ? 'pinned-model' : 'low' }] })
  const close = vi.fn(async () => {})
  const connect = vi.spyOn(bridge as any, 'connectAgent').mockResolvedValue({ request, close })
  expect(await bridge['readModelMetadata']('sem')).toEqual({ model: 'pinned-model', reasoningEffort: 'low' })
  await bridge['readModelMetadata']('sem')
  expect(connect).toHaveBeenCalledTimes(1)
  expect(close).toHaveBeenCalledTimes(1)
  connect.mockResolvedValue({ request: async () => { throw new Error('Method not found') }, close })
  expect(await bridge['readModelMetadata']('ordinary')).toEqual({})
})
