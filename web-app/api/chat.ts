import {
  callOpenAi,
  getChatReply,
  parseBody,
  requirePost,
  resolveModel,
  sendError,
  validateMessages,
  type WebRequest,
  type WebResponse
} from './_shared'

interface ChatRequest {
  messages: unknown
  action?: 'chat' | 'rag' | 'selection-rag'
}

export default async function handler(request: WebRequest, response: WebResponse): Promise<void> {
  try {
    requirePost(request)
    const body = parseBody<ChatRequest>(request)
    const model = resolveModel('chat')
    if (!model) throw new Error('No chat model is configured')
    const messages = validateMessages(body.messages)
    const system =
      body.action === 'selection-rag'
        ? 'You are an AI assistant for a PDF selection. Treat the user-selected text as the primary source. Retrieved snippets are supplementary. Answer directly, without repeating the question, system instructions, or private reasoning.'
        : body.action === 'rag'
          ? 'You answer questions using the supplied PDF snippets. Cite the page number when the snippets provide it. Answer directly, without repeating the question, system instructions, or private reasoning.'
          : 'You are the AIpdf PDF assistant. Answer directly and concisely. Do not repeat the question, system instructions, or private reasoning.'
    const payload = await callOpenAi('/chat/completions', {
      model,
      stream: false,
      temperature: 0.2,
      think: false,
      messages: [{ role: 'system', content: system }, ...messages]
    })
    const reply = getChatReply(payload)
    if (!reply.content) throw new Error('The AI returned an empty answer')
    response.status(200).json(reply)
  } catch (error) {
    sendError(response, error)
  }
}
