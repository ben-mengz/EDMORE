import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { collectFolderSources } from '../src/folder.ts'
import { WeKnoraKnowledgeClient } from '../src/index.ts'

const roots:string[]=[]
afterEach(async()=>{vi.useRealTimers();for(const root of roots.splice(0))await rm(root,{recursive:true,force:true})})
async function root(){const path=await mkdtemp(join(tmpdir(),'wiki-folder-'));roots.push(path);return path}

it('imports nested Markdown/TXT, filters credentials and preserves long Unicode content', async()=> {
  const dir=await root();await mkdir(join(dir,'notes'))
  const text='x'.repeat(169999)+String.fromCodePoint(0x1f600)+' end'
  await writeFile(join(dir,'notes','long.md'),text)
  await writeFile(join(dir,'secret.txt'),'password: example-private-password\nUseful reference')
  await writeFile(join(dir,'.hidden.md'),'hidden')
  await writeFile(join(dir,'raw.jsonl'),'raw journal')
  await symlink(join(dir,'secret.txt'),join(dir,'linked.md'))
  const docs=await collectFolderSources(dir)
  expect(docs).toHaveLength(3)
  const long=docs.filter(d=>d.title.includes('long.md'))
  expect(long.every(d=>d.content.isWellFormed())).toBe(true)
  expect(long.map(d=>d.content.split('\n\n').slice(1).join('\n\n')).join('')).toBe(text)
  expect(docs.find(d=>d.title.endsWith('secret.txt'))!.content).not.toContain('example-private-password')
  expect(docs.some(d=>/hidden|jsonl|linked/.test(d.title))).toBe(false)
})

it('does not mistake a missing directory or oversized file for an empty snapshot', async()=> {
  const dir=await root()
  await expect(collectFolderSources(join(dir,'missing'))).rejects.toThrow()
  await writeFile(join(dir,'large.md'),'x'.repeat(512001))
  await expect(collectFolderSources(dir)).rejects.toThrow('512 KB')
})

it('deduplicates, updates and retracts only owned imported sources after grace', async()=> {
  vi.useFakeTimers()
  const dir=await root();await writeFile(join(dir,'note.md'),'First revision')
  const docs=new Map<string,any>([['user',{id:'user',title:'EDMORE Imported File note.md',channel:'web',metadata:{content:'My notes'}}]])
  let writes=0,next=1
  const fetcher=vi.fn<typeof fetch>(async(url,init)=> {
    const path=new URL(String(url)).pathname;const id=path.split('/').at(-1)!
    if(init?.method==='DELETE'){docs.delete(id);return Response.json({success:true})}
    if(init?.method==='POST'||init?.method==='PUT') {
      const body=JSON.parse(String(init.body));const key=init.method==='POST'?String(next++):id
      docs.set(key,{...docs.get(key),id:key,title:body.title,channel:body.channel??docs.get(key)?.channel,metadata:{content:body.content,status:body.status},parse_status:'completed'})
      writes++;return Response.json({data:{id:key}})
    }
    return Response.json({data:path.includes('/knowledge-bases/')?[...docs.values()]:docs.get(id),total:docs.size})
  })
  const client=new WeKnoraKnowledgeClient('http://wiki.test','key',undefined,5000,fetcher)
  await client.syncImportDirectory('kb',dir,1000)
  await client.syncImportDirectory('kb',dir,1000)
  expect(writes).toBe(1)
  await writeFile(join(dir,'note.md'),'Second revision')
  await client.syncImportDirectory('kb',dir,1000)
  expect(writes).toBe(2)
  await rm(join(dir,'note.md'))
  await client.syncImportDirectory('kb',dir,1000)
  expect(docs.has('1')).toBe(true)
  await vi.advanceTimersByTimeAsync(1000)
  await client.syncImportDirectory('kb',dir,1000)
  expect(docs.has('1')).toBe(false)
  expect(docs.get('user').metadata.content).toBe('My notes')
})
