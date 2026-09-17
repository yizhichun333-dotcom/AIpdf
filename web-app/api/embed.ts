import {
  MAX_TEXT_LENGTH,
  callOpenAi,
  parseBody,
  requirePost,
  resolveModel,
  sendError,
  type WebRequest,
  type WebResponse
} from './_shared'

interface EmbedRequest {
  input: unknown
}

interface EmbedResponse {
  data?: Array<{ embedding?: number[]; index?: number }>
  model?: string
}

export default async function handler(request: WebRequest, response: WebResponse): Promise<void> {
  try {
    requirePost(request)
    const body = parseBody<EmbedRequest>(request)
    const input = Array.isArray(body.input) ? body.input : [body.input]
    if (
      input.length === 0 ||
      input.length > 32 ||
      input.some((item) => typeof item !== 'string' || item.trim().length > MAX_TEXT_LENGTH)
    ) {
      throw new Error('Embedding input must contain 1 to 32 text items, each up to 10000 characters')
    }
    const model = resolveModel('embedding')
    if (!model) throw new Error('No embedding model is configured')
    const payload = (await callOpenAi('/embeddings', { model, input })) as EmbedResponse
    const embeddings = (payload.data || [])
      .sort((left, right) => (left.index || 0) - (right.index || 0))
      .map((item) => item.embedding || [])
    if (embeddings.length !== input.length || embeddings.some((item) => item.length === 0)) {
      throw new Error('Embedding service returned incomplete vectors')
    }
    response.status(200).json({ embeddings, model: payload.model || model })
  } catch (error) {
    sendError(response, error)
  }
}
