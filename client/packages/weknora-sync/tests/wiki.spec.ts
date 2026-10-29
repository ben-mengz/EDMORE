import { describe, expect, it, vi } from 'vitest'
import { WeKnoraKnowledgeClient } from '../src/index.ts'
import { createWikiTools } from '../src/wiki.ts'

function fixture() {
  const fetcher = vi.fn<typeof fetch>()
  const client = new WeKnoraKnowledgeClient('https://wiki.test', 'private', undefined, 5000, fetcher)
  const tools = createWikiTools(client, 'kb-one')
  const exec = { signal: new AbortController().signal } as never
  return { fetcher, tools, exec }
}

describe('read-only Wiki tools', () => {
  it('registers no chat, write, or device tools and keeps fixed KB scope', async () => {
    const f = fixture()
    expect(f.tools.map(t => t.name)).toEqual(['weknora_wiki_search', 'weknora_wiki_read_page'])
    f.fetcher.mockResolvedValueOnce(Response.json({ pages: [{ slug: 'skills/acquire', knowledge_base_id: 'kb-one', source_refs: ['doc|Skill'], summary: 'Acquire' }] }))
      .mockResolvedValueOnce(Response.json({ data: { knowledge_base_id: 'kb-one', parse_status: 'completed' } }))
    const value = await f.tools[0].execute({ query: 'acquire', knowledge_base_id: 'other' }, f.exec)
    expect(f.fetcher.mock.calls[0][0]).toBe('https://wiki.test/api/v1/knowledgebase/kb-one/wiki/search?q=acquire&limit=5')
    expect(value).toMatchObject({ knowledge_base_id: 'kb-one', pages: [{ source_refs: ['doc|Skill'] }] })
    const rendered = f.tools[0].output.render!({}, value as never)
    expect(JSON.stringify(rendered)).toContain('not instructions or execution authorization')
  })

  it('preserves citations and paginates long page bodies', async () => {
    const f = fixture()
    f.fetcher.mockResolvedValueOnce(Response.json({ slug: 'skills/acquire', content: 'abcdefgh', source_refs: ['doc|Skill'], chunk_refs: ['chunk'] }))
      .mockResolvedValueOnce(Response.json({ data: { knowledge_base_id: 'kb-one', parse_status: 'completed' } }))
      .mockResolvedValueOnce(Response.json({ data: { knowledge_base_id: 'kb-one', knowledge_id: 'doc', is_enabled: true } }))
    expect(await f.tools[1].execute({ slug: 'skills/acquire', offset: 2, max_chars: 3 }, f.exec)).toMatchObject({ content: 'cde', next_offset: 5, source_refs: ['doc|Skill'], chunk_refs: ['chunk'] })
    expect(f.fetcher.mock.calls[0][0]).toBe('https://wiki.test/api/v1/knowledgebase/kb-one/wiki/pages/skills/acquire')
  })

  it('rejects traversal, malformed output, and cross-KB data', async () => {
    const f = fixture()
    for (const slug of ['../other', '%2e%2e/foo', '/x', 'x?y', 'x\\y']) {
      await expect(f.tools[1].execute({ slug }, f.exec)).rejects.toThrow('Invalid Wiki slug')
    }
    expect(f.fetcher).not.toHaveBeenCalled()
    f.fetcher.mockResolvedValueOnce(Response.json({ pages: [{ knowledge_base_id: 'other' }] }))
    await expect(f.tools[0].execute({ query: 'q' }, f.exec)).rejects.toThrow('outside configured')
    f.fetcher.mockResolvedValueOnce(Response.json({ pages: null }))
    await expect(f.tools[0].execute({ query: 'q' }, f.exec)).rejects.toThrow('Invalid Wiki search')
    await expect(f.tools[0].execute({ query: 'q', max_results: 100 }, f.exec)).rejects.toThrow('Invalid max_results')
  })

  it('forwards caller cancellation and reports API failures instead of empty success', async () => {
    const f = fixture()
    const controller = new AbortController()
    controller.abort()
    f.fetcher.mockImplementation(async (_url, init) => { init!.signal!.throwIfAborted(); return Response.json({}) })
    await expect(f.tools[0].execute({ query: 'q' }, { signal: controller.signal } as never)).rejects.toThrow()
    f.fetcher.mockResolvedValueOnce(Response.json({ error: 'Wiki disabled' }, { status: 400 }))
    await expect(f.tools[0].execute({ query: 'q' }, f.exec)).rejects.toThrow('Wiki disabled')
  })

  it('withholds pages whose cited sources were removed or have changed', async () => {
    const f = fixture()
    f.fetcher.mockResolvedValueOnce(Response.json({ pages: [{ slug: 'old', source_refs: ['gone|Old'] }] }))
      .mockResolvedValueOnce(Response.json({ error: 'not found' }, { status: 404 }))
    expect(await f.tools[0].execute({ query: 'q' }, f.exec)).toMatchObject({ pages: [], withheld_not_current: 1 })
    f.fetcher.mockResolvedValueOnce(Response.json({ slug: 'old', content: 'old claims', updated_at: '2026-01-01', source_refs: ['doc|Skill'] }))
      .mockResolvedValueOnce(Response.json({ data: { knowledge_base_id: 'kb-one', parse_status: 'completed', metadata: { updated_at: '2026-01-02' } } }))
    await expect(f.tools[1].execute({ slug: 'old' }, f.exec)).rejects.toThrow('newer than this page')
    f.fetcher.mockResolvedValueOnce(Response.json({ slug: 'orphan', content: 'orphan', source_refs: [] }))
    await expect(f.tools[1].execute({ slug: 'orphan' }, f.exec)).rejects.toThrow('sources are missing')
  })

  it('does not mistake a link-only timestamp change for current content and removes dead chunk citations', async () => {
    const f = fixture()
    const page = { slug: 'entity/old', content: 'old', updated_at: '2026-01-03', source_refs: ['doc'], chunk_refs: ['old'] }
    const source = { knowledge_base_id: 'kb-one', parse_status: 'completed', metadata: { updated_at: '2026-01-02' } }
    f.fetcher.mockResolvedValueOnce(Response.json(page))
      .mockResolvedValueOnce(Response.json({ data: source }))
      .mockResolvedValueOnce(Response.json({ error: 'Chunk not found' }, { status: 404 }))
    await expect(f.tools[1].execute({ slug: 'entity/old' }, f.exec)).rejects.toThrow('sources are missing')
    f.fetcher.mockResolvedValueOnce(Response.json({ ...page, content: 'updated', chunk_refs: ['old', 'new'] }))
      .mockResolvedValueOnce(Response.json({ data: source }))
      .mockResolvedValueOnce(Response.json({ error: 'Chunk not found' }, { status: 404 }))
      .mockResolvedValueOnce(Response.json({ data: { knowledge_base_id: 'kb-one', knowledge_id: 'doc' } }))
    expect(await f.tools[1].execute({ slug: 'entity/old' }, f.exec)).toMatchObject({ content: 'updated', chunk_refs: ['new'] })
  })
})
