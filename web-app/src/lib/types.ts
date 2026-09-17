export type ChatRole = 'user' | 'assistant'
export type ChatAction = 'chat' | 'translate' | 'explain' | 'vision'

export interface TextBlock {
  id: number
  column: 'single' | 'left' | 'right'
  x: number
  y: number
  width: number
  height: number
  text: string
}

export interface ImageSelection {
  left: number
  top: number
  width: number
  height: number
}

export interface ChatMessage {
  id: string
  role: ChatRole
  content: string
  action: ChatAction
  createdAt: number
  pageNumber?: number
  sourceText?: string
  thinking?: string
  webSources?: WebSearchResult[]
}

export interface WebSearchResult {
  title: string
  url: string
  snippet: string
}

export interface Annotation {
  id: string
  fileHash: string
  pageNumber: number
  kind: 'text' | 'image'
  selectedText?: string
  imageSelection?: ImageSelection
  comment: string
  createdAt: number
}

export interface StoredDocument {
  fileHash: string
  fileName: string
  pageCount: number
  data: ArrayBuffer
  updatedAt: number
}

export interface RagChunk {
  id: string
  pageNumber: number
  text: string
}

export interface RagIndex {
  id: string
  fileHash: string
  embeddingModel: string
  chunks: RagChunk[]
  embeddings: number[][]
  updatedAt: number
}
