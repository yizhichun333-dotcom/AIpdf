import { app, ipcMain } from 'electron'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { getAiRuntimeConfig, type AiRuntimeConfig } from './ai-config.ipc'

interface RagChunkInput {
  id: string
  pageNumber: number
  text: string
}

interface StoredRagChunk extends RagChunkInput {
  embedding: number[]
}

interface StoredRagIndex {
  version: 2
  sourceHash: string
  embeddingSignature: string
  chunks: StoredRagChunk[]
}

interface OllamaEmbedResponse {
  embeddings?: number[][]
}

interface ApiEmbedResponse {
  data?: Array<{ embedding?: number[] }>
}

const EMBEDDING_MODEL = 'embeddinggemma'
const EMBEDDING_BATCH_SIZE = 16

const hashText = (value: string): string =>
  createHash('sha256').update(value).digest('hex')

const getIndexPath = (filePath: string): string => {
  const fileId = hashText(filePath)
  return join(app.getPath('userData'), 'rag-index', `${fileId}.json`)
}

const readIndex = async (
  filePath: string
): Promise<StoredRagIndex | null> => {
  try {
    return JSON.parse(
      await readFile(getIndexPath(filePath), 'utf8')
    ) as StoredRagIndex
  } catch {
    return null
  }
}

const getEmbeddingModel = (runtime: AiRuntimeConfig): string =>
  runtime.backend === 'ollama' ? EMBEDDING_MODEL : runtime.model

// 不同模型产生的向量不能混用；切换后会自动重新建立当前 PDF 的索引。
const getEmbeddingSignature = (runtime: AiRuntimeConfig): string =>
  runtime.backend === 'ollama'
    ? `ollama:${EMBEDDING_MODEL}`
    : `api:${runtime.apiBaseUrl}:${runtime.model}`

const createEmbeddings = async (
  inputs: string[],
  runtime: AiRuntimeConfig
): Promise<number[][]> => {
  const model = getEmbeddingModel(runtime)
  const response =
    runtime.backend === 'api'
      ? await fetch(`${runtime.apiBaseUrl}/embeddings`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(runtime.apiKey
              ? { Authorization: `Bearer ${runtime.apiKey}` }
              : {})
          },
          body: JSON.stringify({ model, input: inputs })
        })
      : await fetch('http://localhost:11434/api/embed', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model,
            input: inputs,
            truncate: true
          })
        })

  if (!response.ok) {
    throw new Error(
      `${runtime.backend === 'api' ? 'API' : 'Embedding'} 请求失败：${response.status}`
    )
  }

  if (runtime.backend === 'api') {
    const result = (await response.json()) as ApiEmbedResponse
    const embeddings = (result.data ?? [])
      .map((item) => item.embedding)
      .filter((embedding): embedding is number[] => Boolean(embedding))
    if (embeddings.length !== inputs.length) {
      throw new Error('API 没有返回完整的嵌入向量')
    }
    return embeddings
  }

  const result = (await response.json()) as OllamaEmbedResponse
  if (!result.embeddings || result.embeddings.length !== inputs.length) {
    throw new Error(
      `Embedding 请求没有返回完整向量。请确认已执行 ollama pull ${EMBEDDING_MODEL}`
    )
  }

  return result.embeddings
}

const cosineSimilarity = (left: number[], right: number[]): number => {
  let dot = 0
  let leftMagnitude = 0
  let rightMagnitude = 0

  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index] ?? 0
    const rightValue = right[index] ?? 0
    dot += leftValue * rightValue
    leftMagnitude += leftValue * leftValue
    rightMagnitude += rightValue * rightValue
  }

  if (leftMagnitude === 0 || rightMagnitude === 0) {
    return 0
  }

  return dot / Math.sqrt(leftMagnitude * rightMagnitude)
}

export function registerRagIpc(): void {
  ipcMain.handle(
    'rag:index-document',
    async (
      _event,
      request: { filePath: string; chunks: RagChunkInput[] }
    ): Promise<{ cached: boolean; chunkCount: number }> => {
      const chunks = request.chunks.filter((chunk) => chunk.text.trim())
      const sourceHash = hashText(JSON.stringify(chunks))
      const runtime = await getAiRuntimeConfig('embedding')
      const embeddingSignature = getEmbeddingSignature(runtime)
      const existingIndex = await readIndex(request.filePath)

      if (
        existingIndex?.version === 2 &&
        existingIndex.sourceHash === sourceHash &&
        existingIndex.embeddingSignature === embeddingSignature
      ) {
        return { cached: true, chunkCount: existingIndex.chunks.length }
      }

      console.log(
        `[rag] indexing backend=${runtime.backend}, model=${getEmbeddingModel(runtime)}, chunks=${chunks.length}`
      )

      const storedChunks: StoredRagChunk[] = []
      for (let start = 0; start < chunks.length; start += EMBEDDING_BATCH_SIZE) {
        const batch = chunks.slice(start, start + EMBEDDING_BATCH_SIZE)
        const embeddings = await createEmbeddings(
          batch.map((chunk) => chunk.text),
          runtime
        )

        batch.forEach((chunk, index) => {
          const embedding = embeddings[index]
          if (!embedding) {
            throw new Error('嵌入模型返回的向量数量不足')
          }
          storedChunks.push({ ...chunk, embedding })
        })
      }

      const index: StoredRagIndex = {
        version: 2,
        sourceHash,
        embeddingSignature,
        chunks: storedChunks
      }
      const indexPath = getIndexPath(request.filePath)
      await mkdir(join(app.getPath('userData'), 'rag-index'), {
        recursive: true
      })
      await writeFile(indexPath, JSON.stringify(index), 'utf8')

      return { cached: false, chunkCount: storedChunks.length }
    }
  )

  ipcMain.handle(
    'rag:search',
    async (
      _event,
      request: { filePath: string; query: string; limit?: number }
    ): Promise<Array<{ pageNumber: number; text: string; score: number }>> => {
      const index = await readIndex(request.filePath)
      if (!index || index.version !== 2 || !index.chunks.length) {
        return []
      }

      const runtime = await getAiRuntimeConfig('embedding')
      if (index.embeddingSignature !== getEmbeddingSignature(runtime)) {
        return []
      }

      const [queryEmbedding] = await createEmbeddings([request.query], runtime)
      if (!queryEmbedding) {
        throw new Error('嵌入模型没有返回查询向量')
      }

      return index.chunks
        .map((chunk) => ({
          pageNumber: chunk.pageNumber,
          text: chunk.text,
          score: cosineSimilarity(queryEmbedding, chunk.embedding)
        }))
        .sort((left, right) => right.score - left.score)
        .slice(0, Math.max(1, Math.min(request.limit ?? 5, 8)))
    }
  )
}
