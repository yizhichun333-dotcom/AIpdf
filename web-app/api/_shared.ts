declare const process: { env: Record<string, string | undefined> }

export interface WebRequest {
  method?: string
  body?: unknown
}

export interface WebResponse {
  status: (code: number) => WebResponse
  json: (value: unknown) => void
}

export type AiRole = 'translation' | 'chat' | 'vision' | 'embedding'

export interface OpenAiMessage {
  role: 'system' | 'user' | 'assistant'
  content: unknown
}

interface OpenAiResponse {
  choices?: Array<{
    message?: {
      content?: string | Array<{ text?: string }>
      reasoning_content?: string
      thinking?: string
    }
  }>
}

export const MAX_TEXT_LENGTH = 10_000
export const MAX_IMAGE_LENGTH = 12 * 1024 * 1024

export const parseBody = <T>(request: WebRequest): T => {
  if (typeof request.body === 'string') return JSON.parse(request.body) as T
  if (!request.body || typeof request.body !== 'object') throw new Error('Request body is empty')
  return request.body as T
}

export const requirePost = (request: WebRequest): void => {
  if (request.method && request.method !== 'POST') throw new Error('Only POST is supported')
}

export const sendError = (response: WebResponse, error: unknown): void => {
  const message = error instanceof Error ? error.message : 'Server request failed'
  response.status(400).json({ error: message })
}

export const resolveModel = (role: AiRole): string => {
  const roleVariable = {
    translation: 'AI_TRANSLATION_MODEL',
    chat: 'AI_CHAT_MODEL',
    vision: 'AI_VISION_MODEL',
    embedding: 'AI_EMBEDDING_MODEL'
  }[role]
  return process.env[roleVariable]?.trim() || process.env.AI_DEFAULT_MODEL?.trim() || ''
}

const getAiBaseUrl = (): string => (process.env.AI_API_BASE_URL || '').trim().replace(/\/+$/, '')

export const callOpenAi = async (path: string, body: unknown): Promise<unknown> => {
  const baseUrl = getAiBaseUrl()
  const apiKey = process.env.AI_API_KEY?.trim()
  if (!baseUrl) throw new Error('AI_API_BASE_URL is not configured on Vercel')
  if (!apiKey) throw new Error('AI_API_KEY is not configured on Vercel')

  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify(body)
  })
  const payload = (await response.json().catch(() => ({}))) as {
    error?: { message?: string } | string
  }
  if (!response.ok) {
    const detail = typeof payload.error === 'string' ? payload.error : payload.error?.message
    throw new Error(`Upstream AI request failed (${response.status}): ${detail || 'no detail'}`)
  }
  return payload
}

export const getMessageContent = (content: unknown): string => {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => (part && typeof part === 'object' && 'text' in part && typeof part.text === 'string' ? part.text : ''))
    .join('')
}

export const splitThinking = (
  content: string,
  thinking?: string
): { content: string; thinking?: string } => {
  const matches = [...content.matchAll(/<\/think>\s*/gi)]
  const lastMatch = matches.at(-1)
  if (lastMatch?.index !== undefined) {
    const embedded = content.slice(0, lastMatch.index).replace(/^<think>\s*/i, '').trim()
    return {
      content: content.slice(lastMatch.index + lastMatch[0].length).trim(),
      thinking: [thinking?.trim(), embedded].filter(Boolean).join('\n\n') || undefined
    }
  }
  return {
    content: content.replace(/^<think>\s*/i, '').trim(),
    thinking: thinking?.trim() || undefined
  }
}

export const getChatReply = (payload: unknown): { content: string; thinking?: string } => {
  const result = payload as OpenAiResponse
  const message = result.choices?.[0]?.message
  return splitThinking(
    getMessageContent(message?.content),
    message?.reasoning_content ?? message?.thinking
  )
}

export const validateMessages = (value: unknown): OpenAiMessage[] => {
  if (!Array.isArray(value) || value.length === 0 || value.length > 12) {
    throw new Error('Conversation must contain 1 to 12 messages')
  }
  return value.map((message) => {
    if (
      !message ||
      typeof message !== 'object' ||
      !('role' in message) ||
      !('content' in message) ||
      !['system', 'user', 'assistant'].includes(String(message.role)) ||
      typeof message.content !== 'string'
    ) {
      throw new Error('Invalid conversation message')
    }
    const content = String(message.content).trim()
    if (!content || content.length > MAX_TEXT_LENGTH) {
      throw new Error('Each message must contain 1 to 10000 characters')
    }
    return { role: message.role as OpenAiMessage['role'], content }
  })
}
