import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply, collectCapabilities, personalCapabilities, renderCapabilitySources, splitCatalog, WeKnoraKnowledgeClient, type Config } from '../src/index.ts'

const config: Config = {
  baseUrl: 'http://weknora.test', apiKey: 'test-key', knowledgeBaseId: 'kb', cwd: '/workspace',
  documentTitle: 'EDMORE Capability Catalog', debounceMs: 100, syncIntervalMs: 1000,
  requestTimeoutMs: 5000, failOnSyncError: false,
}

function fixture() {
  const docs = new Map<string, any>()
  let next = 1
  let offline = false
  const writes: any[] = []
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    if (offline) throw new Error('offline')
    const u = new URL(String(url))
    if (init?.method === 'DELETE') {
      docs.delete(u.pathname.split('/').at(-1)!)
      return Response.json({ success: true })
    }
    if (init?.method === 'POST' || init?.method === 'PUT') {
      const body = JSON.parse(String(init.body))
      const id = init.method === 'POST' ? String(next++) : u.pathname.split('/').at(-1)!
      const old = docs.get(id)
      docs.set(id, { ...old, id, title: body.title, channel: body.channel ?? old?.channel,
        metadata: { content: body.content, status: body.status }, parse_status: 'completed' })
      writes.push(body)
      return Response.json({ data: { id } })
    }
    if (u.pathname.includes('/knowledge-bases/')) {
      const matches = [...docs.values()].filter(row => row.title.includes(u.searchParams.get('keyword') ?? ''))
      const offset = (Number(u.searchParams.get('page') ?? 1) - 1) * 100
      return Response.json({ data: matches.slice(offset, offset + 100), total: matches.length })
    }
    return Response.json({ data: docs.get(u.pathname.split('/').at(-1)!) })
  })
  const handlers = new Map<string, () => void>()
  const cleanup: (() => unknown)[] = []
  const skill = { name: 'custom', content: 'Original instructions', invocation: {}, description: 'Custom', provider: 'test' }
  const ctx = {
    skills: { list: async () => [skill], get: async () => skill }, tools: { schemas: () => [], register: vi.fn() },
    logger: { info: vi.fn(), warn: vi.fn() },
    on: (name: string, fn: () => void) => { handlers.set(name, fn); return () => handlers.delete(name) },
    effect: (factory: () => () => unknown) => cleanup.push(factory()),
  }
  vi.stubGlobal('fetch', fetcher)
  return { docs, writes, ctx, skill, handlers, fetcher, setOffline: (value: boolean) => { offline = value },
    dispose: async () => { for (const fn of cleanup.reverse()) await fn() } }
}

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

describe('automatic synchronization', () => {
  it('keeps server skills out of private sync while preserving same-name personal overrides',()=> {
    const skill=(name:string,path:string)=>({name,path,resourceBase:{kind:'directory',path},source:'custom'}) as never
    const snapshot={generatedAt:'',skills:[skill('public','/server/skills/public'),skill('override','/user/skills/override'),skill('snapshot','/user/admin-skills/1/snapshot'),skill('similar','/server/skills-other/similar')],workflows:new Map([['public','shared'],['override','private']]),mcpTools:[{name:'mcp__common__read'},{name:'mcp__personal__read'}] as never}
    const result=personalCapabilities(snapshot,['/server/skills','/user/admin-skills'],['personal'])
    expect(result.skills.map(s=>s.name)).toEqual(['override','similar'])
    expect([...result.workflows.keys()]).toEqual(['override'])
    expect(result.mcpTools.map(t=>t.name)).toEqual(['mcp__personal__read'])
    expect(()=>personalCapabilities(snapshot,[],[])).toThrow('authoritative')
  })
  it('routes research to public read credentials and capabilities to both private and shared scopes',async()=> {
    const f=fixture()
    const wiki=vi.spyOn(WeKnoraKnowledgeClient.prototype,'searchWiki').mockResolvedValue({pages:[]})
    const search=vi.spyOn(WeKnoraKnowledgeClient.prototype,'searchReferences').mockResolvedValue({data:[]})
    try {
      await apply(f.ctx as never,{...config,sharedKnowledgeBaseId:'public',researchKnowledgeBaseId:'research',readApiKey:'public-read'})
      const lookup=f.ctx.tools.register.mock.calls.map(([t])=>t).find(t=>t.name==='weknora_knowledge_lookup')
      const exec={signal:new AbortController().signal}
      expect(await lookup.execute({scope:'capabilities',query:'align'},exec)).toMatchObject({mode:'scoped',results:[{knowledge_base_id:'kb',origin:'personal'},{knowledge_base_id:'public',origin:'shared-harness'}]})
      expect(await lookup.execute({scope:'research',query:'physics'},exec)).toMatchObject({knowledge_base_id:'research',origin:'shared-research'})
      expect((search.mock.instances[2] as any).apiKey).toBe('public-read')
    }finally{await f.dispose();wiki.mockRestore();search.mockRestore()}
  })
  it('scopes history lookup, prefers Wiki and falls back to source retrieval', async () => {
    vi.useFakeTimers()
    const f = fixture()
    const wiki = vi.spyOn(WeKnoraKnowledgeClient.prototype, 'searchWiki').mockResolvedValue({pages: []})
    const sources = vi.spyOn(WeKnoraKnowledgeClient.prototype, 'searchReferences').mockResolvedValue({data: []})
    const current = vi.spyOn(WeKnoraKnowledgeClient.prototype, 'wikiSourcesCurrent').mockResolvedValue(true)
    try {
      await apply(f.ctx as never, {...config, runsKnowledgeBaseId:'runs', conversationsKnowledgeBaseId:'chat'})
      const tools = f.ctx.tools.register.mock.calls.map(([tool])=>tool)
      const lookup = tools.find(tool=>tool.name==='weknora_knowledge_lookup')
      const exec = {signal:new AbortController().signal}
      expect(await lookup.execute({scope:'runs',query:'failure'},exec)).toMatchObject({mode:'source_fallback',knowledge_base_id:'runs'})
      expect(sources).toHaveBeenCalledWith('runs','failure',exec.signal)
      wiki.mockResolvedValueOnce({pages:[{slug:'outcome',knowledge_base_id:'runs',source_refs:['source']}]})
      expect(await lookup.execute({scope:'runs',query:'failure'},exec)).toMatchObject({mode:'wiki'})
      expect(sources).toHaveBeenCalledTimes(1)
      wiki.mockRejectedValueOnce(new Error('offline'))
      expect(await lookup.execute({scope:'conversations',query:'history'},exec)).toMatchObject({mode:'source_fallback',knowledge_base_id:'chat'})
      await expect(lookup.execute({scope:'__proto__',query:'x'},exec)).rejects.toThrow('Unconfigured')
      await expect(lookup.execute({scope:'other',query:'x'},exec)).rejects.toThrow('Unconfigured')
      await expect(lookup.execute({scope:'runs',query:''},exec)).rejects.toThrow('query')
      expect(tools.find(tool=>tool.name==='weknora_runs_wiki_search').description).toContain('weknora_runs_wiki_read_page')
    } finally {
      await f.dispose()
      wiki.mockRestore(); sources.mockRestore(); current.mockRestore()
    }
  })

  it('recovers when WeKnora starts later, detects silent edits, and skips unchanged content', async () => {
    vi.useFakeTimers()
    const f = fixture()
    f.setOffline(true)
    await apply(f.ctx as never, config)
    expect(f.writes).toHaveLength(0)
    f.setOffline(false)
    await vi.advanceTimersByTimeAsync(1000)
    expect(f.writes).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(2000)
    expect(f.writes).toHaveLength(1)
    f.skill.content = 'Changed without a registry event'
    await vi.advanceTimersByTimeAsync(1000)
    expect(f.writes).toHaveLength(2)
    expect(f.writes[1].content).toContain('Changed without a registry event')
    await f.dispose()
    await vi.advanceTimersByTimeAsync(3000)
    expect(f.writes).toHaveLength(2)
  })

  it('debounces changes and retries after a later outage without requiring another change', async () => {
    vi.useFakeTimers()
    const f = fixture()
    await apply(f.ctx as never, config)
    f.setOffline(true)
    f.skill.content = 'Updated'
    for (let i = 0; i < 10; i++) f.handlers.get('skills/change')!()
    await vi.advanceTimersByTimeAsync(100)
    expect(f.writes).toHaveLength(1)
    f.setOffline(false)
    await vi.advanceTimersByTimeAsync(900)
    expect(f.writes).toHaveLength(2)
    await f.dispose()
  })

  it('deduplicates across reloads and republishes after remote deletion or parse failure', async () => {
    vi.useFakeTimers()
    const f = fixture()
    await apply(f.ctx as never, config)
    await f.dispose()
    await apply(f.ctx as never, config)
    expect(f.writes).toHaveLength(1)
    f.docs.get('1').parse_status = 'failed'
    await vi.advanceTimersByTimeAsync(1000)
    expect(f.writes).toHaveLength(2)
    f.docs.clear()
    await vi.advanceTimersByTimeAsync(1000)
    expect(f.writes).toHaveLength(3)
    await f.dispose()
  })

  it('refuses a partial Skill snapshot', async () => {
    const ctx = { skills: { list: async () => [{ name: 'gone' }], get: async () => undefined } }
    await expect(collectCapabilities(ctx as never, '/workspace')).rejects.toThrow('Skill disappeared')
  })

  it('coalesces events during a slow sync and does not lose the trailing update', async () => {
    vi.useFakeTimers()
    const f = fixture()
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    let active = 0, maximum = 0, calls = 0
    f.ctx.skills.get = async () => {
      active++; maximum = Math.max(maximum, active)
      const snapshot = { ...f.skill }
      if (++calls === 1) await gate
      active--
      return snapshot
    }
    const starting = apply(f.ctx as never, config)
    await vi.advanceTimersByTimeAsync(0)
    f.skill.content = 'Trailing update'
    for (let i = 0; i < 10; i++) f.handlers.get('tools/change')!()
    await vi.advanceTimersByTimeAsync(1500)
    release()
    await starting
    expect(maximum).toBe(1)
    expect(calls).toBe(2)
    expect(f.writes).toHaveLength(2)
    expect(f.writes[1].content).toContain('Trailing update')
    await f.dispose()
  })

  it('aborts in-flight HTTP requests on disposal', async () => {
    vi.useFakeTimers()
    const f = fixture()
    await apply(f.ctx as never, config)
    let aborted = false
    f.fetcher.mockImplementationOnce(async (_url, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')) }, { once: true })
    }))
    await vi.advanceTimersByTimeAsync(1000)
    await f.dispose()
    expect(aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('cleans up timers when strict startup fails', async () => {
    vi.useFakeTimers()
    const f = fixture()
    f.setOffline(true)
    await expect(apply(f.ctx as never, { ...config, failOnSyncError: true })).rejects.toThrow('offline')
    expect(vi.getTimerCount()).toBe(0)
    await f.dispose()
  })
})

describe('catalog storage', () => {
  it('bounds retrieved evidence and removes native transfer bookkeeping',async()=> {
    vi.stubGlobal('fetch',vi.fn(async()=>Response.json({data:Array.from({length:8},()=>({id:'chunk',knowledge_id:'source',metadata:{_knowledge_transfer:'internal chunk checkpoint',source:'manual'},content:'Evidence'}))})))
    const client=new WeKnoraKnowledgeClient(config.baseUrl,'read',undefined,5000)
    const result=await client.searchReferences('research','evidence')
    expect(result.data).toHaveLength(5)
    expect((result.data as any[])[0]).toEqual({id:'chunk',knowledge_id:'source',metadata:{source:'manual'},content:'Evidence'})
  })
  it('waits for native Wiki finalization before submitting another source revision', async () => {
    const f = fixture()
    const client = new WeKnoraKnowledgeClient(config.baseUrl, 'key', undefined, 5000)
    const snapshot = await collectCapabilities(f.ctx as never, '/workspace')
    await client.syncSources('kb', config.documentTitle, snapshot)
    f.docs.get('1').parse_status = 'finalizing'
    f.skill.content = 'Newest revision'
    const latest = await collectCapabilities(f.ctx as never, '/workspace')
    await client.syncSources('kb', config.documentTitle, latest)
    expect(f.writes).toHaveLength(1)
    f.docs.get('1').parse_status = 'completed'
    await client.syncSources('kb', config.documentTitle, latest)
    expect(f.writes).toHaveLength(2)
    expect(f.writes[1].content).toContain('Newest revision')
  })
  it('uses stable individual Skills and MCP group sources independent of ordering', () => {
    const snapshot = { generatedAt: '', skills: [], workflows: new Map(), mcpTools: [
      { name: 'mcp__b__tool', description: 'B', parameters: { type: 'object' as const } },
      { name: 'mcp__a__tool', description: 'A', parameters: { type: 'object' as const } },
    ] }
    const sources = renderCapabilitySources(snapshot)
    expect(sources).toHaveLength(2)
    expect(sources[0].title).toContain('[MCP:a]')
    expect(sources[0].content).not.toContain('mcp__b__tool')
    expect(renderCapabilitySources({ ...snapshot, mcpTools: snapshot.mcpTools.toReversed() })).toEqual(sources)
  })

  it('migrates owned legacy pages, preserves user documents and waits before source retraction', async () => {
    vi.useFakeTimers()
    const f = fixture()
    const client = new WeKnoraKnowledgeClient(config.baseUrl, 'key', undefined, 5000)
    await client.syncCatalog('kb', config.documentTitle, 'old combined catalog')
    const snapshot = await collectCapabilities(f.ctx as never, '/workspace')
    const title = `${config.documentTitle} [Skill:custom]`
    f.docs.set('user', { id: 'user', title, channel: 'web', metadata: { content: 'My notes' } })
    await client.syncSources('kb', config.documentTitle, snapshot, 5000)
    expect(f.docs.has('1')).toBe(false)
    expect(f.docs.get('user').metadata.content).toBe('My notes')
    expect(f.docs.get('2').metadata.content).toContain('Original instructions')
    const empty = { ...snapshot, skills: [] }
    await client.syncSources('kb', config.documentTitle, empty, 5000)
    expect(f.docs.has('2')).toBe(true)
    await vi.advanceTimersByTimeAsync(4000)
    await client.syncSources('kb', config.documentTitle, snapshot, 5000)
    await client.syncSources('kb', config.documentTitle, empty, 5000)
    await vi.advanceTimersByTimeAsync(4000)
    await client.syncSources('kb', config.documentTitle, empty, 5000)
    expect(f.docs.has('2')).toBe(true)
    await vi.advanceTimersByTimeAsync(1000)
    await client.syncSources('kb', config.documentTitle, empty, 5000)
    expect(f.docs.has('2')).toBe(false)
    expect(f.docs.has('user')).toBe(true)
  })

  it('keeps legacy documents while replacements are indexing or upload fails', async () => {
    const f = fixture()
    const client = new WeKnoraKnowledgeClient(config.baseUrl, 'key', undefined, 5000)
    await client.syncCatalog('kb', config.documentTitle, 'old combined catalog')
    const snapshot = await collectCapabilities(f.ctx as never, '/workspace')
    const source = renderCapabilitySources(snapshot, config.documentTitle)[0]
    await client.upsertManualKnowledge('kb', source.title, source.content)
    f.docs.get('2').parse_status = 'processing'
    // Simulate remote normalization with a pending parse and matching source marker.
    await client.syncSources('kb', config.documentTitle, snapshot)
    f.docs.get('2').parse_status = 'processing'
    f.docs.set('legacy', { id: 'legacy', title: config.documentTitle, channel: 'edmore-capability-sync' })
    await client.syncSources('kb', config.documentTitle, snapshot)
    expect(f.docs.has('legacy')).toBe(true)
    f.setOffline(true)
    await expect(client.syncSources('kb', config.documentTitle, snapshot)).rejects.toThrow('offline')
    expect(f.docs.has('legacy')).toBe(true)
  })

  it('splits without losing content or splitting surrogate pairs', () => {
    const content = 'x'.repeat(179999) + String.fromCodePoint(0x1f600) + '\n' + 'y'.repeat(230000)
    const parts = splitCatalog(content)
    expect(parts.join('')).toBe(content)
    expect(parts.every(part => part.length <= 180000 && part.isWellFormed())).toBe(true)
  })

  it('splits oversized documents and retires only owned overflow pages after shrinkage', async () => {
    const f = fixture()
    const client = new WeKnoraKnowledgeClient(config.baseUrl, 'key', undefined, 5000)
    await client.syncCatalog('kb', config.documentTitle, 'x'.repeat(210000))
    expect(f.writes).toHaveLength(2)
    expect(f.writes.every(row => row.content.length < 200000)).toBe(true)
    f.docs.set('user', { id: 'user', title: `${config.documentTitle} [part 99]`, channel: 'web' })
    await client.syncCatalog('kb', config.documentTitle, 'short')
    expect(f.docs.get('2').metadata.status).toBe('draft')
    expect(f.docs.get('user').metadata).toBeUndefined()
    const count = f.writes.length
    await client.syncCatalog('kb', config.documentTitle, 'short')
    expect(f.writes).toHaveLength(count)
  })

  it('finds a matching document beyond the first page instead of duplicating it', async () => {
    const f = fixture()
    for (let i = 0; i < 100; i++) f.docs.set(`other-${i}`, { id: `other-${i}`, title: `${config.documentTitle} other ${i}` })
    f.docs.set('target', { id: 'target', title: config.documentTitle, channel: 'edmore-capability-sync', metadata: { content: 'same', status: 'publish' } })
    const client = new WeKnoraKnowledgeClient(config.baseUrl, 'key', undefined, 5000)
    expect(await client.upsertManualKnowledge('kb', config.documentTitle, 'same')).toBe('unchanged')
    expect(f.writes).toHaveLength(0)
  })

  it('does not re-index unchanged source after server-side Markdown sanitization', async () => {
    const f = fixture()
    const client = new WeKnoraKnowledgeClient(config.baseUrl, 'key', undefined, 5000)
    await client.syncCatalog('kb', config.documentTitle, 'Example <input name="x">')
    f.docs.get('1').metadata.content = f.docs.get('1').metadata.content.replace('<input name="x">', '')
    expect(await client.syncCatalog('kb', config.documentTitle, 'Example <input name="x">')).toBe(false)
    expect(f.writes).toHaveLength(1)
    expect(await client.syncCatalog('kb', config.documentTitle, 'Changed example <input name="x">')).toBe(true)
  })
})
