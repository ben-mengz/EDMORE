import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { ConversationRecord } from '@deepseek-ai/dsh-edmore-workspace'
import type {} from '@deepseek-ai/dsh-edmore-workspace'

export const name = 'edmore-conversation-title'
export const inject = ['edmoreEvents', 'edmoreWorkspace', 'edmoreAgentLoop']

export interface Config {
  role: string
  maxInputChars: number
  minAssistantChars: number
}

export const Config: z<Config> = z.object({
  role: z.string().default('title_generator'),
  maxInputChars: z.number().min(200).default(2400),
  minAssistantChars: z.number().min(0).default(20),
})

import type { EdmoreEvent } from '@deepseek-ai/dsh-edmore-contracts'
import type {} from '@deepseek-ai/dsh-edmore-core'
import type {} from '@deepseek-ai/dsh-edmore-runtime/services'

declare module '@deepseek-ai/cordis' {
  interface Context {
    edmoreConversationTitle: boolean
  }
}

interface TitleState {
  userText?: string
  assistantText?: string
  requested?: boolean
}

function recordPayload(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function compactText(value: string, limit: number): string {
  const text = value.replace(/\s+/g, ' ').trim()
  return text.length > limit ? `${text.slice(0, Math.max(0, limit - 3))}...` : text
}

function cleanTitle(value: string): string {
  let title = value.replace(/\s+/g, ' ').trim()
  title = title.replace(/^["'`]+|["'`.]+$/g, '').trim()
  title = title.replace(/^title\s*:\s*/i, '').trim()
  title = title.split('\n')[0]?.trim() ?? ''
  if (title.length > 56) title = `${title.slice(0, 53).trim()}...`
  return title || 'New conversation'
}

function isAutoTitleCandidate(conversation: ConversationRecord, userText: string): boolean {
  if (conversation.auto_title === false) return false
  const current = compactText(conversation.title || '', 56)
  if (current === '' || current === 'New conversation') return true
  return current === compactText(userText, 56)
}

function titlePrompt(userText: string, assistantText: string): string {
  return [
    'Generate a concise title for this EDMORE microscopy conversation.',
    'Return only the title text. No markdown, no quotes, no punctuation unless necessary.',
    'Use 3 to 8 words. Prefer concrete SEM, 4D-STEM, ptychography, ROI, detector, or workflow terms when present.',
    '',
    'User request:',
    userText,
    '',
    'Assistant result:',
    assistantText,
  ].join('\n')
}

export async function apply(ctx: Context, config: Config): Promise<void> {
  const states = new Map<string, TitleState>()
  const running = new Set<string>()

  async function maybeGenerate(sessionId: string, correlationEvent: EdmoreEvent): Promise<void> {
    if (running.has(sessionId)) return
    const state = states.get(sessionId)
    if (state?.requested === true) return
    const userText = state?.userText?.trim()
    const assistantText = state?.assistantText?.trim()
    if (!userText || !assistantText || assistantText.length < config.minAssistantChars) return

    const conversation = ctx.edmoreWorkspace.getConversationBySessionId(sessionId)
    if (conversation === undefined) return
    if (!isAutoTitleCandidate(conversation, userText)) return

    states.set(sessionId, { ...state, requested: true })
    running.add(sessionId)
    const requestEvent = await ctx.edmoreEvents.append({
      type: 'edmore.conversation.title.requested',
      source: 'edmore-conversation-title',
      scope: 'conversation',
      session_id: sessionId,
      correlation_id: correlationEvent.event_id,
      payload: { conversation_id: conversation.id },
    })

    try {
      const rawTitle = await ctx.edmoreAgentLoop.runRoleOnce(
        sessionId,
        config.role,
        titlePrompt(compactText(userText, config.maxInputChars), compactText(assistantText, config.maxInputChars)),
        requestEvent,
        { source: 'edmore-conversation-title', hidden: true },
      )
      const title = cleanTitle(rawTitle)
      const updated = await ctx.edmoreWorkspace.setConversationTitle({
        id: conversation.id,
        title,
        auto: true,
      })
      await ctx.edmoreEvents.append({
        type: 'edmore.conversation.title.generated',
        source: 'edmore-conversation-title',
        scope: 'conversation',
        session_id: sessionId,
        correlation_id: requestEvent.event_id,
        payload: { conversation_id: updated.id, title: updated.title },
      })
      await ctx.edmoreEvents.append({
        type: 'edmore.conversation.updated',
        source: 'edmore-conversation-title',
        scope: 'conversation',
        session_id: sessionId,
        correlation_id: requestEvent.event_id,
        payload: { conversation: updated },
      })
    } catch (error) {
      states.set(sessionId, { ...state, requested: false })
      await ctx.edmoreEvents.append({
        type: 'edmore.conversation.title.failed',
        source: 'edmore-conversation-title',
        scope: 'conversation',
        session_id: sessionId,
        correlation_id: requestEvent.event_id,
        payload: { conversation_id: conversation.id, error: error instanceof Error ? error.message : String(error) },
      })
    } finally {
      running.delete(sessionId)
    }
  }

  ctx.effect(() => ctx.edmoreEvents.subscribe((event) => {
    const sessionId = event.session_id
    if (!sessionId) return
    const payload = recordPayload(event.payload)

    if (event.type === 'edmore.trigger.requested') {
      const prompt = textOf(payload.prompt) || textOf(payload.display_text)
      if (!prompt) return
      const state = states.get(sessionId) ?? {}
      if (state.userText === undefined) {
        state.userText = prompt
        states.set(sessionId, state)
      }
      return
    }

    if (event.type === 'edmore.assistant.completed') {
      if (payload.hidden === true || event.source === 'edmore-conversation-title') return
      const text = textOf(payload.text)
      if (!text) return
      const state = states.get(sessionId) ?? {}
      if (state.assistantText === undefined) {
        state.assistantText = text
        states.set(sessionId, state)
      }
      void maybeGenerate(sessionId, event).catch(error => {
        ctx.logger.warn(error instanceof Error ? error : new Error(String(error)))
      })
      return
    }

    if (event.type === 'edmore.approval.requested') {
      const state = states.get(sessionId) ?? {}
      if (state.assistantText === undefined) {
        state.assistantText = JSON.stringify(payload)
        states.set(sessionId, state)
      }
      void maybeGenerate(sessionId, event).catch(error => {
        ctx.logger.warn(error instanceof Error ? error : new Error(String(error)))
      })
    }
  }), 'edmore.conversation-title')
  ctx.provide('edmoreConversationTitle', true)
}
