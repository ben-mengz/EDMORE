import {readFile} from 'node:fs/promises'
import {join} from 'node:path'
import {createHash} from 'node:crypto'
import {FileSystemSkillProvider} from '@deepseek-ai/dsh-skill-filesystem'
import {Client,StreamableHTTPClientTransport} from '@modelcontextprotocol/client'
import {readJson} from '@edmore/plugin-host/storage'

// Only deployment-owned roots and explicitly public MCP registrations are read.
// No user worker snapshots, credentials, URLs or tool execution enter this mirror.
export async function publicCapabilities(root,home,signal) {
  const provider=new FileSystemSkillProvider({get:()=>undefined,logger:console},{signal,invalidate:()=>{}},
    {includeDefaultRoots:false,watch:false,customSkillDirs:[join(home,'auth/admin/edmore/skills'),join(root,'skills')]})
  try {
    const candidates=await provider.list({cwd:root,signal})
    if(!Array.isArray(candidates))throw new Error('Incomplete public Skill scan')
    const winners=new Map()
    for(const candidate of candidates.sort((a,b)=>a.rank-b.rank))if(!winners.has(candidate.name))winners.set(candidate.name,candidate)
    const skills=[],workflows=new Map(),mcpTools=[]
    for(const candidate of winners.values()) {
      const skill=await provider.get(candidate,{cwd:root,signal})
      if(!skill)throw new Error('Public Skill changed while reading')
      skills.push({...skill,source:'shared',provider:'server-managed'})
      if(skill.resourceBase?.kind==='directory')try {workflows.set(skill.name,await readFile(join(skill.resourceBase.path,'references/workflow.yaml'),'utf8'))}catch(error){if(error.code!=='ENOENT')throw error}
    }
    const settings=await readJson(join(home,'auth/admin/settings.json'),{mcp:[]})
    for(const row of settings.mcp.filter(row=>row.enabled&&row.scope==='shared')) {
      if(row.transport!=='streamable-http'||row.kind==='edmore')throw new Error('Public MCP documentation requires a supported metadata transport; retaining previous catalog')
      const client=new Client({name:'edmore-public-knowledge-mirror',version:'1.0.0'})
      const transport=new StreamableHTTPClientTransport(new URL(row.url),{requestInit:{headers:row.headers,signal}})
      try {
        await client.connect(transport)
        const response=await client.listTools(undefined,{cacheMode:'refresh'})
        for(const tool of response.tools) {
          const joined=`mcp__${row.id}__${tool.name}`,normalized=joined.replace(/[^a-zA-Z0-9_-]/g,'_')
          const name=normalized===joined&&normalized.length<=64?normalized:normalized.slice(0,51)+'_'+createHash('sha256').update(`${row.id}\0${tool.name}`).digest('hex').slice(0,12)
          mcpTools.push({name,description:tool.description,parameters:tool.inputSchema})
        }
      } finally {await client.close()}
    }
    return {generatedAt:new Date().toISOString(),skills,mcpTools,workflows}
  } finally {await provider.dispose()}
}
