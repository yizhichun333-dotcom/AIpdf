import { ipcMain } from 'electron'
import { getAiRuntimeConfig } from './ai-config.ipc'
import { getConfiguredModel } from './model.ipc'

interface VisionRequest {
  imageBase64: string
  pageNumber: number
  question: string
}

interface OllamaVisionResponse {
  message?: {
    content?: string
  }
}

interface OpenAiVisionResponse {
  choices?: Array<{
    message?: {
      content?: string | Array<{ text?: string }>
    }
  }>
}

const MAX_IMAGE_BASE64_LENGTH = 12 * 1024 * 1024

const getApiContent = (
  content: string | Array<{ text?: string }> | undefined
): string => {
  if (typeof content === 'string') {
    return content
  }

  return (content ?? [])
    .map((part) => part.text ?? '')
    .join('')
}

const removeThinking = (content: string): string => {
  const matches = [...content.matchAll(/\\?<\/think>\s*/gi)]
  const lastMatch = matches.at(-1)
  if (lastMatch?.index !== undefined) {
    return content
      .slice(lastMatch.index + lastMatch[0].length)
      .trim()
  }
  return content.trim()
}

/**
 * 调用配置的视觉模型理解当前 PDF 页面。图片只在主进程发出请求；
 * Ollama 模式发往本机，API 模式发往用户配置的 OpenAI 兼容接口。
 */
export function registerVisionIpc(): void {
  ipcMain.handle(
    'vision:analyze',
    async (
      _event,
      request: VisionRequest
    ): Promise<{ content: string }> => {
      const imageBase64 = request?.imageBase64?.trim()
      const question = request?.question?.trim()

      if (!imageBase64 || !question || !Number.isInteger(request.pageNumber)) {
        throw new Error('图片理解请求不完整')
      }
      if (imageBase64.length > MAX_IMAGE_BASE64_LENGTH) {
        throw new Error('当前页面图片过大，请缩小页面后重试')
      }

      const runtime = await getAiRuntimeConfig('vision')
      const model =
        runtime.backend === 'ollama'
          ? await getConfiguredModel('vision')
          : runtime.model
      console.log(
        `[vision] backend=${runtime.backend}, model=${model}, page=${request.pageNumber}, imageLength=${imageBase64.length}`
      )

      const systemPrompt =
        '你是 PDF 页面图片理解助手。请只依据用户提供的当前页图片，用简体中文直接回答。能够分析流程图、架构图、实验图、曲线图、表格、图例、坐标轴和图中文字。不要复述问题、任务说明或内部提示词；不要输出思考过程、推理草稿、<think> 标签或模型内部记录。若图片中没有足够信息，请明确说明。'

      const response =
        runtime.backend === 'api'
          ? await fetch(`${runtime.apiBaseUrl}/chat/completions`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                ...(runtime.apiKey
                  ? { Authorization: `Bearer ${runtime.apiKey}` }
                  : {})
              },
              body: JSON.stringify({
                model,
                stream: false,
                temperature: 0.2,
                messages: [
                  { role: 'system', content: systemPrompt },
                  {
                    role: 'user',
                    content: [
                      {
                        type: 'text',
                        text: `这是 PDF 第 ${request.pageNumber} 页的页面图像。用户问题：${question}`
                      },
                      {
                        type: 'image_url',
                        image_url: {
                          url: `data:image/jpeg;base64,${imageBase64}`
                        }
                      }
                    ]
                  }
                ]
              })
            })
          : await fetch('http://localhost:11434/api/chat', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                model,
                stream: false,
                think: false,
                options: {
                  num_ctx: 8192,
                  temperature: 0.2
                },
                messages: [
                  { role: 'system', content: systemPrompt },
                  {
                    role: 'user',
                    content: `这是 PDF 第 ${request.pageNumber} 页的页面图像。用户问题：${question}`,
                    images: [imageBase64]
                  }
                ]
              })
            })

      if (!response.ok) {
        throw new Error(
          `${runtime.backend === 'api' ? 'API' : 'Ollama'} 图片理解请求失败：${response.status}`
        )
      }

      const content =
        runtime.backend === 'api'
          ? getApiContent(
              ((await response.json()) as OpenAiVisionResponse).choices?.[0]
                ?.message?.content
            )
          : ((await response.json()) as OllamaVisionResponse).message?.content ??
            ''
      const answer = removeThinking(content)
      if (!answer) {
        throw new Error('视觉模型没有返回答案')
      }

      return { content: answer }
    }
  )
}
