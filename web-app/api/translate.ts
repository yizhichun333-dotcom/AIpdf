import {
  MAX_TEXT_LENGTH,
  callOpenAi,
  getChatReply,
  parseBody,
  requirePost,
  resolveModel,
  sendError,
  type WebRequest,
  type WebResponse
} from './_shared'

interface TranslateRequest {
  text: unknown
  targetLanguage?: 'zh' | 'en'
  prompt?: unknown
}

export default async function handler(request: WebRequest, response: WebResponse): Promise<void> {
  try {
    requirePost(request)
    const body = parseBody<TranslateRequest>(request)
    const text = typeof body.text === 'string' ? body.text.trim() : ''
    if (!text || text.length > MAX_TEXT_LENGTH) throw new Error('Translation text must be 1 to 10000 characters')
    const model = resolveModel('translation')
    if (!model) throw new Error('No translation model is configured')
    const target = body.targetLanguage === 'en' ? 'English' : 'Simplified Chinese'
    const userPrompt = typeof body.prompt === 'string' ? body.prompt.trim() : ''
    const payload = await callOpenAi('/chat/completions', {
      model,
      stream: false,
      temperature: 0.1,
      think: false,
      messages: [
        {
          role: 'system',
          content: `Translate the supplied PDF text into ${target}. Preserve paragraph order and labels such as LEFT COLUMN and RIGHT COLUMN. Output only the translation, with no analysis or preface.`
        },
        { role: 'user', content: `${userPrompt ? `${userPrompt}\n\n` : ''}${text}` }
      ]
    })
    const reply = getChatReply(payload)
    if (!reply.content) throw new Error('The translation model returned an empty answer')
    response.status(200).json(reply)
  } catch (error) {
    sendError(response, error)
  }
}
