import { describe, expect, it, vi } from 'vitest'
import { apply, renderCapabilityCatalog, WeKnoraKnowledgeClient } from '../src/index.ts'

describe('renderCapabilityCatalog', () => {
  it('renders skills, workflow contracts, and grouped MCP schemas without execution authority', () => {
    const content = renderCapabilityCatalog({
      generatedAt: '2026-09-29T00:00:00.000Z',
      skills: [{
        name: 'acquire-4d-stem',
        description: 'Acquire one dataset.',
        invocation: { modelInvocable: true, userInvocable: true },
        source: 'bundled',
        provider: 'filesystem',
        content: 'Follow the EDMORE plan.',
      }],
      workflows: new Map([['acquire-4d-stem', 'steps:\n  - id: acquire']]),
      mcpTools: [{
        name: 'mcp__asyncroscopy__acquire',
        description: 'Acquire through the digital twin.',
        parameters: { type: 'object', properties: { dwell_time: { type: 'number' } } },
      }],
    })

    expect(content).toContain('EDMORE Harness remains the only execution authority')
    expect(content).toContain('## Skill: acquire-4d-stem')
    expect(content).toContain('### EDMORE workflow contract')
    expect(content).toContain('## MCP server: asyncroscopy')
    expect(content).toContain('"dwell_time"')
    expect(content).toContain('{"type":"object","properties":')
    expect(content).not.toContain('Generated:')
  })
})

describe('WeKnoraKnowledgeClient', () => {
  it('creates the catalog when no exact-title manual knowledge exists', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ success: true, data: [] })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ success: true, data: { id: 'new' } })))
    const client = new WeKnoraKnowledgeClient('https://weknora.example', 'secret', undefined, 5000, fetchImpl)

    await expect(client.upsertManualKnowledge('kb-1', 'EDMORE Capability Catalog', '# Catalog')).resolves.toBe('created')
    expect(fetchImpl).toHaveBeenNthCalledWith(2,
      'https://weknora.example/api/v1/knowledge-bases/kb-1/knowledge/manual',
      expect.objectContaining({ method: 'POST' }),
    )
    expect(JSON.parse(String(fetchImpl.mock.calls[1]![1]?.body)).process_config).toMatchObject({
      summary_enabled: false, question_generation_config: { enabled: false }, graph_enabled: false,
    })
  })

  it('updates the exact-title catalog and sends tenant-scoped authentication', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ success: true, data: [{ id: 'knowledge-1', title: 'EDMORE Capability Catalog', channel: 'edmore-capability-sync' }] })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ success: true, data: { metadata: { content: '# Old', status: 'publish' } } })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ success: true, data: { id: 'knowledge-1' } })))
    const client = new WeKnoraKnowledgeClient('https://weknora.example/api/v1/', 'secret', 'tenant-1', 5000, fetchImpl)

    await expect(client.upsertManualKnowledge('kb-1', 'EDMORE Capability Catalog', '# Updated')).resolves.toBe('updated')
    const [, init] = fetchImpl.mock.calls[2]!
    expect(fetchImpl.mock.calls[2]![0]).toBe('https://weknora.example/api/v1/knowledge/manual/knowledge-1')
    expect(init?.method).toBe('PUT')
    expect(new Headers(init?.headers).get('X-Tenant-ID')).toBe('tenant-1')
    expect(new Headers(init?.headers).get('X-API-Key')).toBe('secret')
    expect(JSON.parse(String(init?.body)).process_config.summary_enabled).toBe(false)
  })
})

describe('plugin lifecycle', () => {
  it('does not block EDMORE when the initial WeKnora sync fails', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn<typeof fetch>().mockRejectedValue(new Error('offline'))
    const warnings: string[] = []
    const ctx = {
      skills: { list: async () => [], get: async () => undefined },
      tools: { schemas: () => [], register: vi.fn() },
      logger: { info: () => {}, warn: (message: string) => warnings.push(message) },
      on: () => () => {},
      effect: (factory: () => unknown) => factory(),
    }
    try {
      await expect(apply(ctx as never, {
        baseUrl: 'https://weknora.example',
        apiKey: 'secret',
        knowledgeBaseId: 'kb-1',
        cwd: '/workspace',
        documentTitle: 'EDMORE Capability Catalog',
        debounceMs: 100,
        requestTimeoutMs: 1000,
        failOnSyncError: false,
      })).resolves.toBeUndefined()
      expect(warnings).toEqual([expect.stringContaining('initial sync failed: offline')])
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
