import type { ChatMessage, WebSearchResult } from './types'

interface ApiErrorResponse {
  error?: string
}

export interface ChatReply {
  content: string
  thinking?: string
}

export interface EmbedReply {
  embeddings: number[][]
  model: string
}

const getErrorMessage = (value: unknown): string =>
  value instanceof Error ? value.message : 'Request failed'

const postJson = async <T>(path: string, body: unknown): Promise<T> => {
  let response: Response
  try {
    response = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
  } catch (error) {
    throw new Error(`Cannot connect to the Web AI service: ${getErrorMessage(error)}`)
  }

  const payload = (await response.json().catch(() => ({}))) as T & ApiErrorResponse
  if (!response.ok) {
    throw new Error(payload.error || `Web AI request failed (${response.status})`)
  }
  return payload
}

export const chat = async (request: {
  messages: Array<Pick<ChatMessage, 'role' | 'content'>>
  action?: 'chat' | 'rag' | 'selection-rag'
  webSearchEnabled?: boolean
}): Promise<ChatReply> => postJson<ChatReply>('/api/chat', request)

export const translate = async (request: {
  text: string
  targetLanguage: 'zh' | 'en'
  prompt?: string
}): Promise<ChatReply> => postJson<ChatReply>('/api/translate', request)

export const analyzeVision = async (request: {
  imageBase64: string
  pageNumber: number
  question: string
}): Promise<ChatReply> => postJson<ChatReply>('/api/vision', request)

export const embed = async (input: string | string[]): Promise<EmbedReply> =>
  postJson<EmbedReply>('/api/embed', { input })

export const searchWeb = async (query: string): Promise<WebSearchResult[]> =>
  postJson<WebSearchResult[]>('/api/search', { query })
