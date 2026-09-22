import type { ContentBlock } from '@deepseek-ai/dsh-llm'
function asRecord(value: unknown): Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {} }

export function contentText(content: ContentBlock[]): string {
  const parts = content.map((block) => {
    if (block.type === 'text' || block.type === 'reasoning') return block.text
    if (block.type === 'tool-call') return `${block.name}(${block.arguments})`
    if (block.type === 'tool-result') return contentText(block.content)
    return `[${block.type}]`
  })
  return parts.join('\n').trim()
}

export function projectMcpContent(content: unknown[], toolName: string): ContentBlock[] {
  const text: string[] = []
  for (const value of content) {
    const block = asRecord(value)
    const type = typeof block.type === 'string' ? block.type : 'unknown'
    if (type === 'text') {
      if (typeof block.text === 'string') text.push(block.text)
      continue
    }
    if (type === 'resource_link') {
      const uri = typeof block.uri === 'string' ? block.uri : ''
      const name = typeof block.name === 'string' ? block.name : uri
      text.push(uri ? `[resource link: ${name}] ${uri}` : `[resource link: ${name}]`)
      continue
    }
    if (type === 'resource') {
      const resource = asRecord(block.resource)
      const uri = typeof resource.uri === 'string' ? resource.uri : ''
      const resourceText = typeof resource.text === 'string' ? resource.text : ''
      text.push(resourceText || (uri ? `[resource: ${uri}]` : '[resource result]'))
      continue
    }
    if (type === 'image') {
      const mime = typeof block.mimeType === 'string' ? block.mimeType : 'image'
      text.push(`[${mime} result omitted from text view]`)
      continue
    }
    if (type === 'audio') {
      const mime = typeof block.mimeType === 'string' ? block.mimeType : 'audio'
      text.push(`[${mime} result omitted from text view]`)
      continue
    }
    text.push(`[unsupported MCP content type: ${type}]`)
  }
  return text.length > 0 ? [{ type: 'text', text: text.join('\n') }] : [{ type: 'text', text: `(${toolName} returned no model-visible content)` }]
}

