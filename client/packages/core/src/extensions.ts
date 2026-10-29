export interface ConversationExtension {
  id: string
  title: string
  asset(name: string): Promise<{ body: string; type: string } | undefined>
  state(session: string): Promise<unknown>
  update(session: string, input: Record<string, unknown>): Promise<unknown>
  prompt?(session: string): string
  denial?(session: string, tool: string, args: unknown): string | undefined
}

export class ConversationExtensions {
  private entries = new Map<string, ConversationExtension>()
  register(extension: ConversationExtension): () => void {
    if (!/^[a-z][a-z0-9-]*$/.test(extension.id) || this.entries.has(extension.id)) throw new Error('Invalid or duplicate conversation extension')
    this.entries.set(extension.id, extension)
    return () => { if (this.entries.get(extension.id) === extension) this.entries.delete(extension.id) }
  }
  list() { return [...this.entries.values()].map(({ id, title }) => ({ id, title, module: `/api/edmore/extensions/${id}/panel.js` })) }
  get(id: string) { return this.entries.get(id) }
  prompt(session: string) { return [...this.entries.values()].map(item => item.prompt?.(session)).filter(Boolean).join('\n') }
  denial(session: string, tool: string, args: unknown) {
    for (const extension of this.entries.values()) {
      const reason = extension.denial?.(session, tool, args)
      if (reason) return reason
    }
  }
}
