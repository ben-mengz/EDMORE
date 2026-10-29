import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import YAML from 'yaml'
import { apply } from '@wxg-prc-cpg/dsh-weknora'

describe('retrieval-only backend profile', () => {
  it('registers retrieval tools without exposing a second chat agent', () => {
    const source = readFileSync(new URL('../../plugin-wiki/cordis.patch.yml', import.meta.url), 'utf8')
    const rows = YAML.parse(source, { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value: string) => value }] })
    const row = rows.flatMap((patch: any) => patch.insert ?? []).find((entry: any) => entry.id === 'weknora')
    expect(row.config.agentId).toBeUndefined()
    expect(row.config.tools.ask).toBe(false)
    const names: string[] = []
    apply({ tools: { register: (tool: { name: string }) => { names.push(tool.name) } } } as never, {
      baseUrl: 'http://127.0.0.1:8080', tools: row.config.tools,
    })
    expect(names).toEqual(['weknora_list_knowledge_bases', 'weknora_search', 'weknora_read_document'])
  })
})
