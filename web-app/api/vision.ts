import {
  MAX_IMAGE_LENGTH,
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

interface VisionRequest {
  imageBase64: unknown
  pageNumber: unknown
  question: unknown
}

export default async function handler(request: WebRequest, response: WebResponse): Promise<void> {
  try {
    requirePost(request)
    const body = parseBody<VisionRequest>(request)
    const imageBase64 = typeof body.imageBase64 === 'string' ? body.imageBase64.trim() : ''
    const question = typeof body.question === 'string' ? body.question.trim() : ''
    if (!imageBase64 || imageBase64.length > MAX_IMAGE_LENGTH) throw new Error('Image must be smaller than 12 MB')
    if (!question || question.length > MAX_TEXT_LENGTH) throw new Error('Question must be 1 to 10000 characters')
    const model = resolveModel('vision')
    if (!model) throw new Error('No vision model is configured')
    const payload = await callOpenAi('/chat/completions', {
      model,
      stream: false,
      temperature: 0.2,
      think: false,
      messages: [
        {
          role: 'system',
          content: 'Analyze the supplied PDF image. Answer directly. Do not repeat the question, system instructions, or private reasoning.'
        },
        {
          role: 'user',
          content: [
            { type: 'text', text: `PDF page ${String(body.pageNumber)}. ${question}` },
            { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${imageBase64}` } }
          ]
        }
      ]
    })
    const reply = getChatReply(payload)
    if (!reply.content) throw new Error('The vision model returned an empty answer')
    response.status(200).json(reply)
  } catch (error) {
    sendError(response, error)
  }
}
