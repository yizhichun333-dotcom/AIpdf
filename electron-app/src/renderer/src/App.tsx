// 导入React钩子：useRef获取DOM元素；useState管理组件状态
import {
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useRef,
  useState
} from 'react'
// 导入可拖拽分栏面板组件：Group分组、Panel面板、Separator分割条
import { Group, Panel, Separator } from 'react-resizable-panels'
// 导入pdfjs‑dist legacy兼容版本，解析渲染PDF文档
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs'
// 导入pdfjs的worker工作线程文件，后台解析PDF
import pdfWorker from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url'
// 配置pdfjs worker地址，必须配置否则解析报错
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorker


// 打开PDF返回的数据类型，与主进程IPC返回结构对应
interface OpenedPdf {
  filePath: string    // PDF本地绝对路径
  fileName: string    // PDF文件名
  data: Uint8Array    // PDF二进制原始数据
}

type ChatRole = 'user' | 'assistant'

type ChatAction =
  | 'chat'
  | 'translate'
  | 'explain'
  | 'vision'

interface ChatMessage {
  id: string
  role: ChatRole
  content: string
  action: ChatAction
  createdAt: number
  pageNumber?: number
  sourceText?: string
  // 仅保存模型推理以便排查；不在普通答案区域展示。
  thinking?: string
  // 联网回答使用的来源；与消息一起保存，重新打开 PDF 后仍可查看。
  webSources?: WebSearchResult[]
}

interface WebSearchResult {
  title: string
  url: string
  snippet: string
}

type WebSearchProvider = 'bing' | 'duckduckgo'

// 用户自己的阅读批注：与 AI 消息分开保存，避免被自动发送给模型。
interface PdfAnnotation {
  id: string
  pageNumber: number
  kind: 'text' | 'image'
  selectedText?: string
  imageSelection?: ImageSelection
  comment: string
  createdAt: number
}

type ModelRole = 'translation' | 'chat' | 'vision'

type AiBackend = 'ollama' | 'api'

interface ApiModelConfig {
  translation: string
  chat: string
  vision: string
  embedding: string
}

const API_MODEL_FIELDS: Array<{
  key: keyof ApiModelConfig
  label: string
  placeholder: string
}> = [
  {
    key: 'translation',
    label: '翻译模型',
    placeholder: '例如：gpt-4o-mini'
  },
  {
    key: 'chat',
    label: '对话模型',
    placeholder: '例如：gpt-4o-mini'
  },
  {
    key: 'vision',
    label: '视觉模型',
    placeholder: '例如：qwen-vl-plus'
  },
  {
    key: 'embedding',
    label: 'Embedding 模型',
    placeholder: '例如：text-embedding-3-small'
  }
]

interface LocalModelCandidate {
  id: string
  label: string
  description: string
  size: string
  role: ModelRole
}

interface LocalModelState {
  candidates: LocalModelCandidate[]
  installedModelIds: string[]
  preferences: Record<ModelRole, string>
}

// 图片选区使用 0~1 的归一化坐标保存，因此缩放 PDF 后仍能裁剪到同一张图。
interface ImageSelection {
  left: number
  top: number
  width: number
  height: number
}

const MIN_IMAGE_SELECTION_SIZE = 0.01

const isValidImageSelection = (
  value: unknown
): value is ImageSelection => {
  if (!value || typeof value !== 'object') {
    return false
  }

  const selection = value as Record<string, unknown>
  return ['left', 'top', 'width', 'height'].every(
    (key) =>
      typeof selection[key] === 'number' &&
      Number.isFinite(selection[key])
  )
}
// interface TextSpanInfo {
//   element: HTMLSpanElement
//   text: string
//   left: number
//   top: number
//   right: number
// }

// const getOrderedTextSpans = (
//   textLayer: HTMLDivElement
// ): HTMLSpanElement[] => {
//   const layerRect = textLayer.getBoundingClientRect()

//   const items: TextSpanInfo[] = Array.from(
//     textLayer.querySelectorAll('span')
//   )
//     .map((element) => {
//       const rect = element.getBoundingClientRect()

//       return {
//         element,
//         text: element.textContent?.trim() ?? '',
//         left: rect.left - layerRect.left,
//         top: rect.top - layerRect.top,
//         right: rect.right - layerRect.left
//       }
//     })
//     .filter((item) => item.text.length > 0)

//   if (items.length === 0) {
//     return []
//   }

//   const sortedByLeft = [...items].sort(
//     (a, b) => a.left - b.left
//   )

//   let largestGap = 0
//   let splitIndex = -1

//   for (let index = 0; index < sortedByLeft.length - 1; index += 1) {
//     const current = sortedByLeft[index]
//     const next = sortedByLeft[index + 1]

//     const gap = next.left - current.right

//     if (gap > largestGap) {
//       largestGap = gap
//       splitIndex = index
//     }
//   }

//   const columnGapThreshold = layerRect.width * 0.12
//   const isTwoColumn =
//     splitIndex >= 0 &&
//     largestGap > columnGapThreshold

//   const sortTopToBottom = (
//     a: TextSpanInfo,
//     b: TextSpanInfo
//   ): number => {
//     const topDifference = a.top - b.top

//     if (Math.abs(topDifference) > 8) {
//       return topDifference
//     }

//     return a.left - b.left
//   }

//   if (!isTwoColumn) {
//     return items
//       .sort(sortTopToBottom)
//       .map((item) => item.element)
//   }

//   const splitX =
//     (sortedByLeft[splitIndex].right +
//       sortedByLeft[splitIndex + 1].left) /
//     2

//   const leftColumn = items
//     .filter((item) => item.left < splitX)
//     .sort(sortTopToBottom)

//   const rightColumn = items
//     .filter((item) => item.left >= splitX)
//     .sort(sortTopToBottom)

//   return [
//     ...leftColumn,
//     ...rightColumn
//   ].map((item) => item.element)
// }
interface TextSpanInfo {
  element: HTMLSpanElement
  text: string
  left: number
  top: number
  right: number
  bottom: number
}

// 单次发送给本地模型的当前页原文最多 10,000 个字符，避免长页导致响应过慢。
const MAX_AI_PAGE_TEXT_LENGTH = 10_000
// 选区讨论与检索片段共用 Qwen 的 8192 上下文，分别限制长度避免长选区挤掉问题。
const MAX_SELECTION_RAG_TEXT_LENGTH = 2_500
const MAX_SELECTION_RAG_RETRIEVED_LENGTH = 3_500
// 网页只作为补充上下文，限制总长度，避免挤占 PDF 原文和对话历史。
const MAX_WEB_CONTEXT_LENGTH = 2_500

const truncateForSelectionRag = (
  text: string,
  maxLength: number
): string => {
  if (text.length <= maxLength) {
    return text
  }

  const candidate = text.slice(0, maxLength)
  const boundary = Math.max(
    candidate.lastIndexOf('。'),
    candidate.lastIndexOf('！'),
    candidate.lastIndexOf('？'),
    candidate.lastIndexOf('. '),
    candidate.lastIndexOf('\n')
  )
  const end = boundary >= Math.floor(maxLength * 0.6)
    ? boundary + 1
    : maxLength

  return candidate.slice(0, end).trim()
}

const createWebSearchContext = (
  results: WebSearchResult[]
): string => {
  if (results.length === 0) {
    return ''
  }

  const context = results
    .map((result, index) =>
      [
        `===== 网页 ${index + 1} 开始 =====`,
        `标题：${result.title}`,
        `网址：${result.url}`,
        `摘要：${result.snippet}`,
        `===== 网页 ${index + 1} 结束 =====`
      ].join('\n')
    )
    .join('\n\n')

  return truncateForSelectionRag(
    `===== 联网检索资料开始 =====\n${context}\n===== 联网检索资料结束 =====`,
    MAX_WEB_CONTEXT_LENGTH
  )
}

const getErrorMessage = (error: unknown): string => {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : ''
  const normalized = message.replace(/\s+/g, ' ').trim()
  return normalized ? normalized.slice(0, 360) : '未知错误'
}

interface TextColumnLayout {
  leftColumn: TextSpanInfo[]
  rightColumn: TextSpanInfo[]
}

type AiTextColumn = 'single' | 'left' | 'right'

interface AiTextBlock {
  id: number
  column: AiTextColumn
  x: number
  y: number
  width: number
  height: number
  text: string
}

interface AiPageContent {
  text: string
  // 普通问答使用的、受 10,000 字符限制的块。
  blocks: AiTextBlock[]
  // 完整翻译使用的全部块，不受单次问答输入上限影响。
  allBlocks: AiTextBlock[]
}

interface RagChunkInput {
  id: string
  pageNumber: number
  text: string
}

interface PdfRagTextItem {
  str: string
  transform: number[]
}

const RAG_CHUNK_SIZE = 800
const RAG_CHUNK_OVERLAP = 120

// 对未渲染页面直接读取 PDF 坐标，并将双栏分别按从上到下的顺序合并。
const extractPageTextForRag = async (
  pdf: pdfjsLib.PDFDocumentProxy,
  pageNumber: number
): Promise<string> => {
  const page = await pdf.getPage(pageNumber)
  const viewport = page.getViewport({ scale: 1 })
  const textContent = await page.getTextContent()
  const items = (textContent.items as unknown as PdfRagTextItem[])
    .filter(
      (item) =>
        typeof item.str === 'string' &&
        Array.isArray(item.transform) &&
        item.str.trim().length > 0
    )
    .map((item) => ({
      text: item.str.trim(),
      x: item.transform[4] ?? 0,
      y: item.transform[5] ?? 0
    }))

  const toLines = (
    columnItems: Array<{ text: string; x: number; y: number }>
  ): string[] => {
    const rows: Array<{
      y: number
      items: Array<{ text: string; x: number }>
    }> = []

    ;[...columnItems]
      .sort((left, right) => right.y - left.y || left.x - right.x)
      .forEach((item) => {
        const row = rows.find((candidate) =>
          Math.abs(candidate.y - item.y) <= 3
        )
        if (row) {
          row.items.push(item)
        } else {
          rows.push({ y: item.y, items: [item] })
        }
      })

    return rows.map((row) =>
      row.items
        .sort((left, right) => left.x - right.x)
        .map((item) => item.text)
        .join(' ')
    )
  }

  const leftItems = items.filter((item) => item.x < viewport.width / 2)
  const rightItems = items.filter((item) => item.x >= viewport.width / 2)
  const isTwoColumn =
    leftItems.length >= 12 &&
    rightItems.length >= 12 &&
    Math.max(...leftItems.map((item) => item.x)) < viewport.width * 0.7 &&
    Math.min(...rightItems.map((item) => item.x)) > viewport.width * 0.3

  return (isTwoColumn
    ? [...toLines(leftItems), ...toLines(rightItems)]
    : toLines(items)
  )
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

const createRagChunks = (
  pageNumber: number,
  pageText: string
): RagChunkInput[] => {
  const lines = pageText
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
  const chunks: RagChunkInput[] = []
  let buffer = ''

  const pushBuffer = (): void => {
    const text = buffer.trim()
    if (!text) {
      return
    }
    chunks.push({
      id: `page-${pageNumber}-chunk-${chunks.length + 1}`,
      pageNumber,
      text
    })
  }

  lines.forEach((line) => {
    const nextBuffer = buffer ? `${buffer}\n${line}` : line
    if (nextBuffer.length <= RAG_CHUNK_SIZE) {
      buffer = nextBuffer
      return
    }

    pushBuffer()
    // 重叠部分避免一个概念、句子或公式恰好被切到两个检索块中。
    buffer = `${buffer.slice(-RAG_CHUNK_OVERLAP)}\n${line}`.trim()
  })
  pushBuffer()

  return chunks
}

// 根据文字 span 的实际页面坐标识别单栏或双栏，并按人类阅读顺序排列。
const getTextColumnLayout = (
  textLayer: HTMLDivElement
): TextColumnLayout => {
  const layerRect = textLayer.getBoundingClientRect()

  const items: TextSpanInfo[] = Array.from(
    textLayer.querySelectorAll('span')
  )
    .map((element) => {
      const rect = element.getBoundingClientRect()

      return {
        element,
        text: element.textContent?.trim() ?? '',
        left: rect.left - layerRect.left,
        top: rect.top - layerRect.top,
        right: rect.right - layerRect.left,
        bottom: rect.bottom - layerRect.top
      }
    })
    .filter((item) => item.text.length > 0)

  if (items.length === 0) {
    return {
      leftColumn: [],
      rightColumn: []
    }
  }

  const sortedByLeft = [...items].sort(
    (a, b) => a.left - b.left
  )

  let largestGap = 0
  let splitIndex = -1

  for (
    let index = 0;
    index < sortedByLeft.length - 1;
    index += 1
  ) {
    const current = sortedByLeft[index]
    const next = sortedByLeft[index + 1]
    const gap = next.left - current.right

    if (gap > largestGap) {
      largestGap = gap
      splitIndex = index
    }
  }

  const columnGapThreshold = layerRect.width * 0.12
  const splitX = layerRect.width / 2
  // 部分 PDF 会把一行拆成许多很窄的 span，span 的 right 会遮住中间栏间距，
  // 因而仅靠“最大空隙”会把双栏误判为单栏。补充检测两侧是否各有足够多的
  // 起始文字块，并要求它们远离页面中线，避免把普通单栏长句误切成两栏。
  const leftColumnCandidates = items.filter(
    (item) => item.left < layerRect.width * 0.48
  )
  const rightColumnCandidates = items.filter(
    (item) => item.left > layerRect.width * 0.52
  )
  const hasTwoColumnDistribution =
    leftColumnCandidates.length >= 12 &&
    rightColumnCandidates.length >= 12 &&
    Math.min(
      leftColumnCandidates.length,
      rightColumnCandidates.length
    ) / items.length >= 0.12
  const isTwoColumn =
    (splitIndex >= 0 && largestGap > columnGapThreshold) ||
    hasTwoColumnDistribution

  const sortTopToBottom = (
    a: TextSpanInfo,
    b: TextSpanInfo
  ): number => {
    const topDifference = a.top - b.top

    if (Math.abs(topDifference) > 8) {
      return topDifference
    }

    return a.left - b.left
  }

  if (!isTwoColumn) {
    return {
      leftColumn: items.sort(sortTopToBottom),
      rightColumn: []
    }
  }

  // 最大空隙只用于判断是否存在双栏。它可能出现在右栏内部，不能直接作为
  // 分栏线；双栏 PDF 的稳定分栏线应使用页面水平中心，避免右栏被并入左栏。
  const leftColumn = items
    .filter((item) => item.left < splitX)
    .sort(sortTopToBottom)

  const rightColumn = items
    .filter((item) => item.left >= splitX)
    .sort(sortTopToBottom)

  return {
    leftColumn,
    rightColumn
  }
}

const getOrderedTextSpans = (
  textLayer: HTMLDivElement
): TextSpanInfo[] => {
  const { leftColumn, rightColumn } =
    getTextColumnLayout(textLayer)

  return [...leftColumn, ...rightColumn]
}

const normalizeAnnotationText = (text: string): string => {
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * 将保存的批注重新映射到当前 PDF.js 文本层。
 * PDF.js 每次翻页/缩放都会重建 span，因此不能直接保存 DOM 引用。
 */
const applyAnnotationMarkers = (
  textLayer: HTMLDivElement,
  pageNumber: number,
  annotations: PdfAnnotation[]
): void => {
  const orderedSpans = getOrderedTextSpans(textLayer)
  const spanRanges: Array<{
    element: HTMLSpanElement
    start: number
    end: number
  }> = []
  let fullText = ''

  for (const item of orderedSpans) {
    const text = normalizeAnnotationText(item.element.textContent ?? '')
    if (!text) {
      continue
    }

    if (fullText) {
      fullText += ' '
    }
    const start = fullText.length
    fullText += text
    spanRanges.push({
      element: item.element,
      start,
      end: fullText.length
    })

    item.element.style.textDecorationLine = ''
    item.element.style.textDecorationStyle = ''
    item.element.style.textDecorationColor = ''
    item.element.style.textUnderlineOffset = ''
    item.element.title = ''
  }

  const pageAnnotations = annotations.filter(
    (annotation) =>
      annotation.pageNumber === pageNumber &&
      annotation.kind !== 'image'
  )

  for (const annotation of pageAnnotations) {
    const targetText = normalizeAnnotationText(annotation.selectedText ?? '')
    if (!targetText) {
      continue
    }

    const matchStart = fullText.indexOf(targetText)
    if (matchStart < 0) {
      continue
    }
    const matchEnd = matchStart + targetText.length

    for (const span of spanRanges) {
      if (span.end <= matchStart || span.start >= matchEnd) {
        continue
      }

      span.element.style.textDecorationLine = 'underline'
      span.element.style.textDecorationStyle = 'dotted'
      span.element.style.textDecorationColor = '#2563eb'
      span.element.style.textUnderlineOffset = '3px'
      span.element.title = span.element.title
        ? `${span.element.title}\n批注：${annotation.comment}`
        : `批注：${annotation.comment}`
    }
  }
}

// 将同一行的 span 合并为文本块，保留归一化坐标供 AI 理解页面版式。
const createAiTextBlocks = (
  items: TextSpanInfo[],
  column: AiTextColumn,
  layerRect: DOMRect
): AiTextBlock[] => {
  const lines: TextSpanInfo[][] = []

  for (const item of items) {
    const lastLine = lines[lines.length - 1]
    const lastItem = lastLine?.[0]

    if (lastItem && Math.abs(item.top - lastItem.top) <= 6) {
      lastLine.push(item)
    } else {
      lines.push([item])
    }
  }

  return lines.map((line, index) => {
    const left = Math.min(...line.map((item) => item.left))
    const top = Math.min(...line.map((item) => item.top))
    const right = Math.max(...line.map((item) => item.right))
    const bottom = Math.max(...line.map((item) => item.bottom))

    return {
      id: index + 1,
      column,
      // 使用百分比坐标，缩放 PDF 时坐标仍保持稳定。
      x: Number(((left / layerRect.width) * 100).toFixed(2)),
      y: Number(((top / layerRect.height) * 100).toFixed(2)),
      width: Number(
        (((right - left) / layerRect.width) * 100).toFixed(2)
      ),
      height: Number(
        (((bottom - top) / layerRect.height) * 100).toFixed(2)
      ),
      text: line.map((item) => item.text).join(' ')
    }
  })
}

const limitAiTextBlocks = (
  blocks: AiTextBlock[],
  maxLength: number
): AiTextBlock[] => {
  const fullLength = blocks.reduce(
    (length, block) => length + block.text.length,
    0
  )
  const truncationNotice = '【后续内容未发送】'
  const textBudget =
    fullLength > maxLength
      ? Math.max(0, maxLength - truncationNotice.length)
      : maxLength
  let usedLength = 0
  const limitedBlocks: AiTextBlock[] = []

  for (const block of blocks) {
    const remainingLength = textBudget - usedLength

    if (remainingLength <= 0) {
      break
    }

    if (block.text.length <= remainingLength) {
      limitedBlocks.push(block)
      usedLength += block.text.length
      continue
    }

    limitedBlocks.push({
      ...block,
      text: `${block.text.slice(0, remainingLength)}${truncationNotice}`
    })
    break
  }

  return limitedBlocks
}

// 为 AI 生成“文字 + 位置”结构；双栏按左栏完整内容后右栏完整内容排列。
const getPageContentForAi = (
  textLayer: HTMLDivElement
): AiPageContent => {
  const { leftColumn, rightColumn } =
    getTextColumnLayout(textLayer)
  const layerRect = textLayer.getBoundingClientRect()
  const toDisplayText = (blocks: AiTextBlock[]): string => {
    return blocks
      .map((block) => block.text)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()
  }

  if (rightColumn.length === 0) {
    const allBlocks = createAiTextBlocks(
      leftColumn,
      'single',
      layerRect
    )
    const blocks = limitAiTextBlocks(
      allBlocks,
      MAX_AI_PAGE_TEXT_LENGTH
    )

    return {
      text: toDisplayText(blocks),
      blocks,
      allBlocks
    }
  }

  // 双栏平均分配字符额度，确保右栏不会因左栏过长而完全丢失。
  const columnMaxLength = Math.floor(
    MAX_AI_PAGE_TEXT_LENGTH / 2
  )
  const leftAllBlocks = createAiTextBlocks(
    leftColumn,
    'left',
    layerRect
  )
  const rightAllBlocks = createAiTextBlocks(
    rightColumn,
    'right',
    layerRect
  )
  const allBlocks = [
    ...leftAllBlocks,
    ...rightAllBlocks
  ].map((block, index) => ({
    ...block,
    id: index + 1
  }))
  const leftBlocks = limitAiTextBlocks(
    allBlocks.filter((block) => block.column === 'left'),
    columnMaxLength
  )
  const rightBlocks = limitAiTextBlocks(
    allBlocks.filter((block) => block.column === 'right'),
    columnMaxLength
  )
  const blocks = [...leftBlocks, ...rightBlocks]

  return {
    text: [
      '【左栏】',
      toDisplayText(leftBlocks),
      '【右栏】',
      toDisplayText(rightBlocks)
    ].join('\n'),
    blocks,
    allBlocks
  }
}

const isFullPageTranslationRequest = (
  question: string
): boolean => {
  const normalizedQuestion = question.replace(/\s+/g, '')
  const pageWords = '(当前页|本页|这一页|这页|整页|全文|全部|完整)'

  return new RegExp(
    `(翻译.*${pageWords}|${pageWords}.*翻译)`
  ).test(normalizedQuestion)
}

const getPageLayout = (
  blocks: AiTextBlock[]
): 'single-column' | 'two-column' => {
  return blocks.some((block) => block.column === 'right')
    ? 'two-column'
    : 'single-column'
}

const createStructuredPageContent = (
  blocks: AiTextBlock[]
): string => {
  return JSON.stringify({
    coordinateUnit: 'percent',
    layout: getPageLayout(blocks),
    blocks
  })
}

const getSelectedTextFromRange = (
  textLayer: HTMLDivElement,
  range: Range
): string => {
  const selectionRects = Array.from(
    range.getClientRects()
  )

  if (selectionRects.length === 0) {
    return ''
  }

  // 获取文本层中所有span元素，并按视觉顺序排序
  const orderedSpans = getOrderedTextSpans(textLayer)
  // 过滤出与选区矩形有重叠的span元素
  const selectedSpans = orderedSpans.filter((item) => {
    const spanRect = item.element.getBoundingClientRect()

    return selectionRects.some((selectionRect) => {
      const overlapX =
        Math.min(
          spanRect.right,
          selectionRect.right
        ) -
        Math.max(
          spanRect.left,
          selectionRect.left
        )

      const overlapY =
        Math.min(
          spanRect.bottom,
          selectionRect.bottom
        ) -
        Math.max(
          spanRect.top,
          selectionRect.top
        )

      return overlapX > 1 && overlapY > 1
    })
  })

  return selectedSpans
    .map((item) => {
      const textNode = Array.from(
        item.element.childNodes
      ).find(
        (node) => node.nodeType === Node.TEXT_NODE
      )

      if (!textNode) {
        return item.text
      }

      let startOffset = 0
      let endOffset = textNode.textContent?.length ?? 0

      if (range.startContainer === textNode) {
        startOffset = range.startOffset
      }

      if (range.endContainer === textNode) {
        endOffset = range.endOffset
      }

      return (
        textNode.textContent?.slice(
          startOffset,
          endOffset
        ) ?? ''
      )
    })
    .join(' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/ +\n/g, '\n')
    .trim()
}

function App(): React.JSX.Element {
  // canvasRef：绑定渲染PDF的canvas DOM元素
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  // textLayerRef：绑定渲染PDF文本的div DOM元素
  const textLayerRef = useRef<HTMLDivElement | null>(null)
  // pdfRef：保存加载完成的PDF文档代理对象，翻页缩放复用，ref不触发重渲染
  const pdfRef = useRef<pdfjsLib.PDFDocumentProxy | null>(null)
  const loadingTaskRef =
    useRef<pdfjsLib.PDFDocumentLoadingTask | null>(null)
  // activePdf：当前打开的PDF文件信息，null代表未打开
  const [activePdf, setActivePdf] = useState<OpenedPdf | null>(null)
  // currentPage：当前展示的页码
  const [currentPage, setCurrentPage] = useState(0)
  // totalPages：PDF文档总页数
  const [totalPages, setTotalPages] = useState(0)
  // scale：缩放比例，1代表100%
  const [scale, setScale] = useState(1)
  // pdfStatus：状态提示文本，加载/失败/文件名
  //const [pageInput, setPageInput] = useState('')
  const [pdfStatus, setPdfStatus] = useState('尚未打开 PDF')
  // isRendering：渲染锁定标记，渲染中禁用按钮防止重复点击
  const [isRendering, setIsRendering] = useState(false)
  // errorMessage：错误信息提示
  const [errorMessage, setErrorMessage] = useState('')
  // currentPageText：当前已渲染页面的文字，AI 对话只发送这一页。
  const [currentPageText, setCurrentPageText] =
    useState('')
  // currentPageBlocks：当前页每个已发送文字块的栏位与百分比坐标。
  const [currentPageBlocks, setCurrentPageBlocks] =
    useState<AiTextBlock[]>([])
  // currentPageAllBlocks：完整翻译使用的全部文字块，不受普通问答上限影响。
  const [currentPageAllBlocks, setCurrentPageAllBlocks] =
    useState<AiTextBlock[]>([])
  // selectedText：当前选中的文本内容
  const [selectedText, setSelectedText] = useState('')
  // discussionText：用户确认用于对话的选区；焦点离开 PDF 后仍保留。
  const [discussionText, setDiscussionText] = useState('')
  const [annotations, setAnnotations] = useState<PdfAnnotation[]>([])
  const [isAnnotationEditorOpen, setIsAnnotationEditorOpen] =
    useState(false)
  const [annotationSourceText, setAnnotationSourceText] = useState('')
  const [imageAnnotationSelection, setImageAnnotationSelection] =
    useState<ImageSelection | null>(null)
  const [annotationDraft, setAnnotationDraft] = useState('')
  const chatInputRef = useRef<HTMLTextAreaElement>(null)
  // 选中文本后悬浮操作菜单的位置（相对浏览器视口）。
  const [selectionMenuPosition, setSelectionMenuPosition] =
    useState<{ left: number; top: number } | null>(null)
  // AI 对话消息也允许被选中；选中后可复制，或作为下一轮提问的上下文。
  const [chatSelectionText, setChatSelectionText] = useState('')
  const [chatSelectionMenuPosition, setChatSelectionMenuPosition] =
    useState<{ left: number; top: number } | null>(null)
  const ragIndexTaskRef = useRef(0)
  const [chatScope, setChatScope] =
    useState<'page' | 'document'>('document')
  // 开启后，每次文字问答会先用问题检索网页，再把结果作为补充资料交给本地模型。
  const [isWebSearchEnabled, setIsWebSearchEnabled] = useState(false)
  const [webSearchStatus, setWebSearchStatus] = useState('')
  const [webSearchProvider, setWebSearchProvider] =
    useState<WebSearchProvider>('bing')
  const [webProxyAddress, setWebProxyAddress] = useState('')
  const [webSearchConfigStatus, setWebSearchConfigStatus] = useState('')
  const [webSearchConfigError, setWebSearchConfigError] = useState('')
  // 图片理解模式只分析当前 Canvas 中渲染出的这一页，不读取 RAG 或文字选区。
  const [isVisionMode, setIsVisionMode] = useState(false)
  const [imageSelection, setImageSelection] =
    useState<ImageSelection | null>(null)
  const imageSelectionStartRef = useRef<{ x: number; y: number } | null>(
    null
  )
  const [isRagReady, setIsRagReady] = useState(false)
  const [ragStatus, setRagStatus] = useState('')
  const [localModelState, setLocalModelState] =
    useState<LocalModelState | null>(null)
  const [activeModelOperation, setActiveModelOperation] =
    useState('')
  const [modelError, setModelError] = useState('')
  // AI 服务可以在本地 Ollama 与 OpenAI 兼容 API 之间切换。
  const [aiBackend, setAiBackend] = useState<AiBackend>('ollama')
  const [apiBaseUrl, setApiBaseUrl] = useState('')
  const [apiKeyInput, setApiKeyInput] = useState('')
  const [apiKeySet, setApiKeySet] = useState(false)
  const [apiModels, setApiModels] = useState<ApiModelConfig>({
    translation: '',
    chat: '',
    vision: '',
    embedding: ''
  })
  const [aiConfigStatus, setAiConfigStatus] = useState('')
  const [aiConfigError, setAiConfigError] = useState('')
  const [customModelIds, setCustomModelIds] = useState<
    Record<ModelRole, string>
  >({
    translation: '',
    chat: '',
    vision: ''
  })
  const visionModelId = localModelState?.preferences.vision ?? ''
  const isVisionModelInstalled = Boolean(
    visionModelId &&
      localModelState?.installedModelIds.includes(visionModelId)
  )
  const isVisionAvailable =
    aiBackend === 'api'
      ? Boolean(
          apiModels.vision.trim()
        )
      : isVisionModelInstalled

  const refreshLocalModels = async (): Promise<void> => {
    try {
      const state = await window.desktop.models.getState()
      setLocalModelState(state as LocalModelState)
      setModelError('')
    } catch (error) {
      console.error('读取本地模型状态失败', error)
      setModelError('无法连接 Ollama，模型列表不可用。')
    }
  }

  const loadAiConfig = async (): Promise<void> => {
    try {
      const config = await window.desktop.ai.getConfig()
      setAiBackend(config.backend)
      setApiBaseUrl(config.apiBaseUrl)
      setApiKeySet(config.apiKeySet)
      setApiModels(config.apiModels)
      setAiConfigError('')
      if (config.backend === 'api') {
        setModelError('')
      }
    } catch (error) {
      console.error('读取 AI 服务配置失败', error)
      setAiConfigError('无法读取 AI 服务配置。')
    }
  }

  const saveAiConfig = async (): Promise<void> => {
    setAiConfigStatus('正在保存 AI 服务配置…')
    setAiConfigError('')

    try {
      const config = await window.desktop.ai.saveConfig({
        backend: aiBackend,
        apiBaseUrl,
        apiKey: apiKeyInput.trim() || undefined,
        apiModels
      })
      setAiBackend(config.backend)
      setApiBaseUrl(config.apiBaseUrl)
      setApiKeySet(config.apiKeySet)
      setApiModels(config.apiModels)
      setApiKeyInput('')
      setAiConfigStatus('AI 服务配置已保存')
      setIsRagReady(false)
      setRagStatus(
        aiBackend === 'api'
          ? '配置已更换，正在使用新的 API 嵌入模型重建索引…'
          : '配置已更换，正在使用本地嵌入模型重建索引…'
      )
      if (activePdf && pdfRef.current) {
        void buildRagIndex(pdfRef.current, activePdf)
      }
      await refreshLocalModels()
    } catch (error) {
      console.error('保存 AI 服务配置失败', error)
      setAiConfigStatus('')
      setAiConfigError(
        error instanceof Error ? error.message : '保存失败，请检查配置。'
      )
    }
  }

  const loadWebSearchConfig = async (): Promise<void> => {
    try {
      const config = await window.desktop.web.getConfig()
      setWebSearchProvider(config.provider)
      setWebProxyAddress(config.proxyAddress)
      setWebSearchConfigError('')
    } catch (error) {
      console.error('读取联网搜索配置失败', error)
      setWebSearchConfigError('无法读取联网搜索配置。')
    }
  }

  const saveWebSearchConfig = async (): Promise<void> => {
    setWebSearchConfigStatus('正在保存搜索配置…')
    setWebSearchConfigError('')

    try {
      const config = await window.desktop.web.setConfig({
        provider: webSearchProvider,
        proxyAddress: webProxyAddress
      })
      setWebSearchProvider(config.provider)
      setWebProxyAddress(config.proxyAddress)
      setWebSearchConfigStatus('搜索接口和代理配置已保存')
    } catch (error) {
      console.error('保存联网搜索配置失败', error)
      setWebSearchConfigStatus('')
      setWebSearchConfigError(
        error instanceof Error
          ? error.message
          : '保存失败，请检查代理地址格式。'
      )
    }
  }

  const downloadModel = async (modelId: string): Promise<void> => {
    setActiveModelOperation(`download:${modelId}`)
    setModelError('')
    try {
      await window.desktop.models.download({ modelId })
      await refreshLocalModels()
    } catch (error) {
      console.error('下载本地模型失败', error)
      setModelError('模型下载失败，请确认网络连接和 Ollama 服务。')
    } finally {
      setActiveModelOperation('')
    }
  }

  const selectModel = async (
    role: ModelRole,
    modelId: string
  ): Promise<void> => {
    setActiveModelOperation(`select:${modelId}`)
    setModelError('')
    try {
      await window.desktop.models.select({ role, modelId })
      await refreshLocalModels()
    } catch (error) {
      console.error('切换本地模型失败', error)
      setModelError('模型切换失败，请确认模型已经下载完成。')
    } finally {
      setActiveModelOperation('')
    }
  }

  const downloadAndSelectCustomModel = async (
    role: ModelRole
  ): Promise<void> => {
    const modelId = customModelIds[role].trim()
    if (!modelId) {
      setModelError('请先输入 Ollama 模型名。')
      return
    }

    setActiveModelOperation(`custom:${role}`)
    setModelError('')
    try {
      const installed = localModelState?.installedModelIds.includes(modelId)
      if (installed) {
        await window.desktop.models.select({ role, modelId })
      } else {
        await window.desktop.models.downloadAndSelect({ role, modelId })
      }
      setCustomModelIds((current) => ({ ...current, [role]: '' }))
      await refreshLocalModels()
    } catch (error) {
      console.error('下载或选择自定义模型失败', error)
      setModelError('操作失败：请检查模型名、网络连接与 Ollama 服务。')
    } finally {
      setActiveModelOperation('')
    }
  }

  // 初始化本地模型状态属于异步外部数据读取；完成后需要同步回 React 状态。
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refreshLocalModels()
  }, [])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadAiConfig()
  }, [])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadWebSearchConfig()
  }, [])

  const getImageSelectionPoint = (
    event: ReactPointerEvent<HTMLDivElement>
  ): { x: number; y: number } => {
    const rect = event.currentTarget.getBoundingClientRect()
    return {
      x: Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)),
      y: Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height))
    }
  }

  const updateImageSelection = (point: { x: number; y: number }): void => {
    const start = imageSelectionStartRef.current
    if (!start) {
      return
    }

    setImageSelection({
      left: Math.min(start.x, point.x),
      top: Math.min(start.y, point.y),
      width: Math.abs(point.x - start.x),
      height: Math.abs(point.y - start.y)
    })
  }

  const handleImageSelectionPointerDown = (
    event: ReactPointerEvent<HTMLDivElement>
  ): void => {
    if (!isVisionMode || isRendering) {
      return
    }

    event.preventDefault()
    const point = getImageSelectionPoint(event)
    imageSelectionStartRef.current = point
    event.currentTarget.setPointerCapture(event.pointerId)
    setImageSelection({ left: point.x, top: point.y, width: 0, height: 0 })
  }

  const handleImageSelectionPointerMove = (
    event: ReactPointerEvent<HTMLDivElement>
  ): void => {
    if (!imageSelectionStartRef.current) {
      return
    }

    event.preventDefault()
    updateImageSelection(getImageSelectionPoint(event))
  }

  const finishImageSelection = (
    event: ReactPointerEvent<HTMLDivElement>
  ): void => {
    const start = imageSelectionStartRef.current
    if (!start) {
      return
    }

    const point = getImageSelectionPoint(event)
    const nextSelection: ImageSelection = {
      left: Math.min(start.x, point.x),
      top: Math.min(start.y, point.y),
      width: Math.abs(point.x - start.x),
      height: Math.abs(point.y - start.y)
    }
    imageSelectionStartRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }

    if (
      nextSelection.width < MIN_IMAGE_SELECTION_SIZE ||
      nextSelection.height < MIN_IMAGE_SELECTION_SIZE
    ) {
      setImageSelection(null)
      return
    }

    setImageSelection(nextSelection)
  }

  const cancelImageSelection = (): void => {
    imageSelectionStartRef.current = null
    setImageSelection(null)
  }

  const [chatMessages, setChatMessages] =
    useState<ChatMessage[]>([])
  const [chatInput, setChatInput] =
    useState('')
  const [isAiLoading, setIsAiLoading] =
    useState(false)
  // aiProgress：完整翻译按文本块运行时显示进度。
  const [aiProgress, setAiProgress] = useState('')
  const [aiError, setAiError] =
    useState('')
  /**
   * 渲染指定页码、指定缩放比例的 PDF 页面到 canvas。
   * @param pdf pdf 文档代理对象
   * @param pageNumber 要渲染的页码
   * @param renderScale 渲染缩放比例
   */
  const renderPage = async (
    pdf: pdfjsLib.PDFDocumentProxy,
    pageNumber: number,
    renderScale: number
  ): Promise<void> => {
    const canvas = canvasRef.current
    if (!canvas) {
      throw new Error('找不到 PDF Canvas')
    }
    setIsRendering(true) // 标记正在渲染，锁定按钮
    try {
      // 获取对应页码页面对象
      const page = await pdf.getPage(pageNumber)
      // const pageText = await extractPageText(
      //   pdf,
      //   pageNumber
      // )
      // setCurrentPageText(pageText)
      // 根据传入缩放获取页面视口尺寸
      const viewport = page.getViewport({
        scale: renderScale
      })

      // 处理高DPI视网膜屏幕，避免渲染模糊
      const outputScale = window.devicePixelRatio || 1
      // canvas真实像素宽高（乘以设备像素比）
      canvas.width = Math.floor(viewport.width * outputScale)
      canvas.height = Math.floor(viewport.height * outputScale)
      // canvas页面显示样式宽高
      canvas.style.width = `${Math.floor(viewport.width)}px`
      canvas.style.height = `${Math.floor(viewport.height)}px`

      // 高DPI屏幕需要的变换矩阵
      const transform =
        outputScale !== 1
          ? [outputScale, 0, 0, outputScale, 0, 0]
          : undefined

      // 将PDF页面渲染到canvas画布
      await page.render({
        canvas,
        viewport,
        transform
      }).promise
      // 一次读取同时服务文字层渲染和当前页 AI 问答，避免遍历整份 PDF。
      const textContent = await page.getTextContent()
      // 翻页或缩放后不沿用上一页的选区，防止其被误作为当前页上下文。
      setSelectedText('')
      setDiscussionText('')
      setSelectionMenuPosition(null)
      cancelImageSelection()

      const textLayer = textLayerRef.current

      if (textLayer) {
        textLayer.replaceChildren()

        textLayer.style.width = `${Math.floor(viewport.width)}px`
        textLayer.style.height = `${Math.floor(viewport.height)}px`

        const textLayerRender = new pdfjsLib.TextLayer({
          textContentSource: textContent,
          container: textLayer,
          viewport
        })

        await textLayerRender.render()

        // 文本层重建完成后恢复当前页已经保存的批注虚线。
        applyAnnotationMarkers(textLayer, pageNumber, annotations)

        // TextLayer 渲染完成后才能读取 span 的视觉坐标，从而正确区分双栏。
        const pageContent = getPageContentForAi(textLayer)
        setCurrentPageText(pageContent.text)
        setCurrentPageBlocks(pageContent.blocks)
        setCurrentPageAllBlocks(pageContent.allBlocks)
      } else {
        // 理论上不会进入；保留兜底以防 TextLayer 尚未挂载。
        const fallbackText = textContent.items
          .map((item) => ('str' in item ? item.str : ''))
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim()
        setCurrentPageText(fallbackText)
        setCurrentPageBlocks([
          {
            id: 1,
            column: 'single',
            x: 0,
            y: 0,
            width: 100,
            height: 100,
            text: fallbackText
          }
        ])
        setCurrentPageAllBlocks([
          {
            id: 1,
            column: 'single',
            x: 0,
            y: 0,
            width: 100,
            height: 100,
            text: fallbackText
          }
        ])
      }
      setCurrentPage(pageNumber) // 更新当前页码
    } finally {
      setIsRendering(false) // 渲染完成，解除锁定
    }
  }

  const buildRagIndex = async (
    pdf: pdfjsLib.PDFDocumentProxy,
    file: OpenedPdf
  ): Promise<void> => {
    const taskId = ragIndexTaskRef.current + 1
    ragIndexTaskRef.current = taskId
    setIsRagReady(false)
    setRagStatus('正在读取整份 PDF，准备全文检索…')

    try {
      const chunks: RagChunkInput[] = []
      for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
        const pageText = await extractPageTextForRag(pdf, pageNumber)
        if (taskId !== ragIndexTaskRef.current) {
          return
        }
        chunks.push(...createRagChunks(pageNumber, pageText))
        setRagStatus(`正在读取全文：${pageNumber} / ${pdf.numPages} 页`)
      }

      if (chunks.length === 0) {
        setRagStatus('未提取到可建立全文检索的文字；扫描版 PDF 需要 OCR。')
        return
      }

      setRagStatus(`正在生成 ${chunks.length} 个检索向量…`)
      const result = await window.desktop.rag.indexDocument({
        filePath: file.filePath,
        chunks
      })

      if (taskId !== ragIndexTaskRef.current) {
        return
      }

      setIsRagReady(true)
      setRagStatus(
        result.cached
          ? `全文检索已就绪：复用 ${result.chunkCount} 个本地索引块`
          : `全文检索已就绪：已建立 ${result.chunkCount} 个本地索引块`
      )
    } catch (error) {
      console.error('RAG 索引建立失败', error)
      if (taskId === ragIndexTaskRef.current) {
        setRagStatus('全文检索建立失败，请检查当前 AI 服务的 Embedding 配置。')
      }
    }
  }

  // 打开PDF文件：调用electron IPC，加载文档并渲染第一页，重置缩放为100%
  const openPdf = async (): Promise<void> => {
    try {
      // 唤起系统文件选择对话框
      const file = await window.desktop.openPdf()
      if (!file) {
        return // 用户取消选择直接退出
      }
      setPdfStatus('正在加载 PDF...')

      // 复制二进制数据，防止原始数据被修改
      const data = file.data.slice()
      // pdfjs加载PDF文档
      const loadingTask = pdfjsLib.getDocument({
        data
      })

      loadingTaskRef.current = loadingTask

      //const pdf = await loadingTask.promise
      const pdf = await loadingTask.promise
      pdfRef.current = pdf // 存入ref供后续翻页缩放使用

      setActivePdf(file)
      setTotalPages(pdf.numPages)
      loadConversation(file)
      loadAnnotations(file)
      setCurrentPageText('')
      setCurrentPageBlocks([])
      setCurrentPageAllBlocks([])
      setChatSelectionText('')
      setChatSelectionMenuPosition(null)
      setIsRagReady(false)
      setRagStatus('')
      setWebSearchStatus('')

      // 打开新PDF，重置缩放比例为100%
      setScale(1)
      await renderPage(pdf, 1, 1)
      setPdfStatus(file.fileName)
      void buildRagIndex(pdf, file)
    } catch (error) {
      console.error('PDF 打开失败：', error)
      setErrorMessage('PDF 打开失败，请确认文件没有损坏')
      setPdfStatus('PDF 打开失败，请查看 Console')
    }
  }

  // 上一页逻辑
  const goToPreviousPage = async (): Promise<void> => {
    const pdf = pdfRef.current
    if (!pdf || currentPage <= 1) {
      return
    }
    // 保持当前缩放比例渲染上一页
    await renderPage(pdf, currentPage - 1, scale)
  }

  // 下一页逻辑
  const goToNextPage = async (): Promise<void> => {
    const pdf = pdfRef.current
    if (!pdf || currentPage >= totalPages) {
      return
    }
    // 保持当前缩放比例渲染下一页
    await renderPage(pdf, currentPage + 1, scale)
  }

  // 缩小：最小限制0.5（50%）
  const zoomOut = async (): Promise<void> => {
    const pdf = pdfRef.current
    if (!pdf) {
      return
    }
    const nextScale = Math.max(0.5, scale - 0.1)
    setScale(nextScale)
    // 使用新缩放重渲染当前页
    await renderPage(
      pdf,
      currentPage,
      nextScale
    )
  }

  // 放大：最大限制2.5（250%）
  const zoomIn = async (): Promise<void> => {
    const pdf = pdfRef.current
    if (!pdf) {
      return
    }
    const nextScale = Math.min(2.5, scale + 0.1)
    setScale(nextScale)
    // 使用新缩放重渲染当前页
    await renderPage(
      pdf,
      currentPage,
      nextScale
    )
  }
  // 重置缩放回到100%
  const resetZoom = async (): Promise<void> => {
    const pdf = pdfRef.current
    if (!pdf) {
      return
    }
    setScale(1)
    await renderPage(
      pdf,
      currentPage,
      1
    )
  }
  const closePdf = async (): Promise<void> => {
  ragIndexTaskRef.current += 1
  if (loadingTaskRef.current) {
    await loadingTaskRef.current.destroy()
  }

  loadingTaskRef.current = null
  pdfRef.current = null
    setActivePdf(null)
    setCurrentPage(0)
    setTotalPages(0)
    setScale(1)
    setPdfStatus('尚未打开 PDF')
    setErrorMessage('')
    setCurrentPageText('')
    setCurrentPageBlocks([])
    setCurrentPageAllBlocks([])
    setSelectedText('')
    setDiscussionText('')
    setAnnotations([])
    setIsAnnotationEditorOpen(false)
    setAnnotationSourceText('')
    setImageAnnotationSelection(null)
    setAnnotationDraft('')
    setSelectionMenuPosition(null)
    setChatSelectionText('')
    setChatSelectionMenuPosition(null)
    cancelImageSelection()
    setIsVisionMode(false)
    setIsRagReady(false)
    setRagStatus('')
    setWebSearchStatus('')
    const canvas = canvasRef.current
    if (canvas) {
      canvas.width = 0
      canvas.height = 0
    }

    const textLayer = textLayerRef.current
    if (textLayer) {
      textLayer.replaceChildren()
    }
  }
  const getConversationKey = (
    file: OpenedPdf
  ): string => {
    return `ai-pdf-conversation:${file.filePath}`
  }
  const loadConversation = (
    file: OpenedPdf
  ): void => {
    const key = getConversationKey(file)
    const saved = localStorage.getItem(key)
    if (!saved) {
      setChatMessages([])
      return
    }
    try {
      setChatMessages(
        JSON.parse(saved) as ChatMessage[]
      )
    } catch {
      setChatMessages([])
    }
  }
  const saveConversation = (
    file: OpenedPdf,
    messages: ChatMessage[]
  ): void => {
    const key = getConversationKey(file)

    localStorage.setItem(
      key,
      JSON.stringify(messages)
    )
  }

  const getAnnotationsKey = (file: OpenedPdf): string => {
    return `ai-pdf-annotations:${file.filePath}`
  }

  const loadAnnotations = (file: OpenedPdf): void => {
    const saved = localStorage.getItem(getAnnotationsKey(file))
    if (!saved) {
      setAnnotations([])
      return
    }

    try {
      const parsed = JSON.parse(saved) as Array<Partial<PdfAnnotation>>
      const normalized = parsed.flatMap((annotation): PdfAnnotation[] => {
        if (
          typeof annotation.id !== 'string' ||
          typeof annotation.pageNumber !== 'number' ||
          typeof annotation.comment !== 'string' ||
          typeof annotation.createdAt !== 'number'
        ) {
          return []
        }

        if (annotation.kind === 'image') {
          if (!isValidImageSelection(annotation.imageSelection)) {
            return []
          }
          return [
            {
              id: annotation.id,
              pageNumber: annotation.pageNumber,
              kind: 'image',
              imageSelection: annotation.imageSelection,
              comment: annotation.comment,
              createdAt: annotation.createdAt
            }
          ]
        }

        // 兼容之前只保存 selectedText、没有 kind 字段的旧文字批注。
        if (typeof annotation.selectedText !== 'string') {
          return []
        }
        return [
          {
            id: annotation.id,
            pageNumber: annotation.pageNumber,
            kind: 'text',
            selectedText: annotation.selectedText,
            comment: annotation.comment,
            createdAt: annotation.createdAt
          }
        ]
      })
      setAnnotations(normalized)
    } catch {
      setAnnotations([])
    }
  }

  const saveAnnotations = (
    file: OpenedPdf,
    nextAnnotations: PdfAnnotation[]
  ): void => {
    localStorage.setItem(
      getAnnotationsKey(file),
      JSON.stringify(nextAnnotations)
    )
  }

  const startAnnotationForSelectedText = (): void => {
    const sourceText = selectedText.trim()
    if (!sourceText || !activePdf) {
      return
    }

    setAnnotationSourceText(sourceText)
    setImageAnnotationSelection(null)
    setAnnotationDraft('')
    setIsAnnotationEditorOpen(true)
    setSelectionMenuPosition(null)
  }

  const startAnnotationForImageSelection = (): void => {
    if (!activePdf || !imageSelection) {
      return
    }

    setAnnotationSourceText('')
    setImageAnnotationSelection({ ...imageSelection })
    setAnnotationDraft('')
    setIsAnnotationEditorOpen(true)
    setSelectionMenuPosition(null)
  }

  const saveAnnotation = (): void => {
    const comment = annotationDraft.trim()
    if (
      !activePdf ||
      (!annotationSourceText && !imageAnnotationSelection) ||
      !comment
    ) {
      return
    }

    const annotation: PdfAnnotation = {
      id: `${Date.now()}-annotation`,
      pageNumber: currentPage,
      kind: imageAnnotationSelection ? 'image' : 'text',
      selectedText: imageAnnotationSelection ? undefined : annotationSourceText,
      imageSelection: imageAnnotationSelection ?? undefined,
      comment,
      createdAt: Date.now()
    }
    const nextAnnotations = [...annotations, annotation]
    setAnnotations(nextAnnotations)
    saveAnnotations(activePdf, nextAnnotations)
    setIsAnnotationEditorOpen(false)
    setAnnotationSourceText('')
    setImageAnnotationSelection(null)
    setAnnotationDraft('')
    cancelImageSelection()
  }

  const deleteAnnotation = (annotationId: string): void => {
    if (!activePdf) {
      return
    }

    const nextAnnotations = annotations.filter(
      (annotation) => annotation.id !== annotationId
    )
    setAnnotations(nextAnnotations)
    saveAnnotations(activePdf, nextAnnotations)
  }
  /**
   * 发送右侧 AI 对话。
   * 只发送当前页文字，避免整份 PDF 超出 Ollama 上下文而超时。
   */
  const translateCurrentPageCompletely = async (): Promise<{
    content: string
    thinking?: string
  }> => {
    const translations: string[] = []
    const thoughts: string[] = []

    for (
      let index = 0;
      index < currentPageAllBlocks.length;
      index += 1
    ) {
      const block = currentPageAllBlocks[index]

      setAiProgress(
        `正在完整翻译：${index + 1} / ${currentPageAllBlocks.length}`
      )

      const reply =
        await window.desktop.translator.translate({
          // 双栏顺序已由程序固定为“左栏全部块 → 右栏全部块”。翻译模型只接收
          // 当前块原文，避免它回显 JSON、块编号或分隔标记。
          text: block.text,
          targetLanguage: 'zh',
          action: 'translate',
          prompt:
            '完整翻译当前结构化文本块为简体中文。只输出该文本块的译文，不要省略、总结、解释或输出编号。'
        })

      translations.push(reply.content)
      if (reply.thinking) {
        thoughts.push(`文本块 ${index + 1}：${reply.thinking}`)
      }
    }

    return {
      content: translations.join('\n\n'),
      thinking: thoughts.join('\n\n') || undefined
    }
  }

  /**
   * 从 PDF.js 已渲染的当前页复制一份适合传给视觉模型的 JPEG。
   * Canvas 原图在高 DPI 屏幕上可能很大，因此最长边限制为 1800 像素。
   */
  const getCurrentPageImageBase64 = (): string => {
    const sourceCanvas = canvasRef.current
    if (!sourceCanvas || !sourceCanvas.width || !sourceCanvas.height) {
      throw new Error('当前页面尚未渲染完成，无法进行图片理解')
    }

    const hasImageSelection = Boolean(
      imageSelection &&
        imageSelection.width >= MIN_IMAGE_SELECTION_SIZE &&
        imageSelection.height >= MIN_IMAGE_SELECTION_SIZE
    )
    const sourceX = hasImageSelection
      ? Math.round(imageSelection!.left * sourceCanvas.width)
      : 0
    const sourceY = hasImageSelection
      ? Math.round(imageSelection!.top * sourceCanvas.height)
      : 0
    const sourceWidth = hasImageSelection
      ? Math.max(1, Math.round(imageSelection!.width * sourceCanvas.width))
      : sourceCanvas.width
    const sourceHeight = hasImageSelection
      ? Math.max(1, Math.round(imageSelection!.height * sourceCanvas.height))
      : sourceCanvas.height

    const maxDimension = 1800
    const ratio = Math.min(
      1,
      maxDimension / Math.max(sourceWidth, sourceHeight)
    )
    const imageCanvas = document.createElement('canvas')
    imageCanvas.width = Math.max(1, Math.round(sourceWidth * ratio))
    imageCanvas.height = Math.max(1, Math.round(sourceHeight * ratio))

    const context = imageCanvas.getContext('2d')
    if (!context) {
      throw new Error('无法准备当前页图片')
    }

    context.drawImage(
      sourceCanvas,
      sourceX,
      sourceY,
      sourceWidth,
      sourceHeight,
      0,
      0,
      imageCanvas.width,
      imageCanvas.height
    )
    const dataUrl = imageCanvas.toDataURL('image/jpeg', 0.9)
    return dataUrl.split(',', 2)[1] ?? ''
  }

  const analyzeCurrentPageImage = async (
    question: string
  ): Promise<{ content: string; thinking?: string }> => {
    const imageBase64 = getCurrentPageImageBase64()
    if (!imageBase64) {
      throw new Error('当前页面图片为空，无法进行图片理解')
    }

    return window.desktop.vision.analyze({
      imageBase64,
      pageNumber: currentPage,
      question
    })
  }

  const sendChatMessage = async (
    presetQuestion?: string,
    forceTextMode = false
  ): Promise<void> => {
    // 既支持用户在输入框提问，也支持“翻译当前页”按钮直接发起固定任务。
    const question = (presetQuestion ?? chatInput).trim()

    if (!question || isAiLoading || isRendering) {
      return
    }

    if (!activePdf) {
      setAiError('请先打开一个 PDF 文件。')
      return
    }

    const useVision = isVisionMode && !forceTextMode
    if (useVision && !isVisionAvailable) {
      setAiError(
        aiBackend === 'api'
          ? '请先在左侧 AI 服务设置中填写视觉模型名称。'
          : '请先在左侧“本地 AI 模型”中下载并设定视觉模型。'
      )
      return
    }

    if (
      !useVision &&
      (!currentPageText || currentPageBlocks.length === 0)
    ) {
      setAiError(
        '当前页没有可提取的文字，可能是扫描图片 PDF，需要先进行 OCR。'
      )
      return
    }

    // 已确认的讨论选区优先；未确认时，仍兼容当前正在拖选的文字。
    const activeDiscussionText = discussionText || selectedText
    const pinnedDiscussionText = discussionText.trim()

    const userMessage: ChatMessage = {
      id: `${Date.now()}-user`,
      role: 'user',
      content: question,
      action: useVision ? 'vision' : 'chat',
      createdAt: Date.now(),
      pageNumber: currentPage || undefined,
      sourceText: activeDiscussionText || undefined
    }
    const messagesBeforeAnswer = [
      ...chatMessages,
      userMessage
    ]

    setChatMessages(messagesBeforeAnswer)
    setChatInput('')
    setAiError('')
    setIsAiLoading(true)
    setAiProgress('')

    const fullPageTranslation = isFullPageTranslationRequest(question)
    const shouldSearchWeb =
      isWebSearchEnabled && !useVision && !fullPageTranslation
    let webResults: WebSearchResult[] = []
    let webContext = ''

    if (shouldSearchWeb) {
      setWebSearchStatus('正在联网搜索…')
      try {
        webResults = await window.desktop.web.search({
          query: question,
          limit: 5
        })
        webContext = createWebSearchContext(webResults)
        setWebSearchStatus(
          webResults.length > 0
            ? `已找到 ${webResults.length} 条网页资料，将作为补充依据`
            : '未找到网页资料，本次继续使用 PDF 内容'
        )
      } catch (error) {
        const reason = getErrorMessage(error)
        console.warn('联网搜索失败，本次继续使用本地 PDF/RAG', error)
        setWebSearchStatus(
          `联网搜索失败：${reason}；本次继续使用本地 PDF/RAG`
        )
      }
    } else if (fullPageTranslation && isWebSearchEnabled) {
      setWebSearchStatus('整页翻译暂不使用联网搜索')
    } else if (!isWebSearchEnabled) {
      setWebSearchStatus('')
    }

    try {
      const reply = useVision
        ? await analyzeCurrentPageImage(question)
        : fullPageTranslation
        ? await translateCurrentPageCompletely()
        : pinnedDiscussionText
          ? await (async (): Promise<{ content: string; thinking?: string }> => {
              if (!isRagReady) {
                throw new Error('选区 + 全文检索正在建立索引，请稍后再试')
              }

              const matches = await window.desktop.rag.search({
                filePath: activePdf.filePath,
                query: question,
                limit: 5
              })
              const maxLengthPerMatch = Math.max(
                1,
                Math.floor(
                  MAX_SELECTION_RAG_RETRIEVED_LENGTH /
                    Math.max(matches.length, 1)
                )
              )
              const retrievedContext = matches
                .map(
                  (match, index) => [
                    `===== 检索片段 ${index + 1}（第 ${match.pageNumber} 页）开始 =====`,
                    truncateForSelectionRag(
                      match.text,
                      maxLengthPerMatch
                    ),
                    `===== 检索片段 ${index + 1}（第 ${match.pageNumber} 页）结束 =====`
                  ].join('\n')
                )
                .join('\n\n')
              const selectedContext = truncateForSelectionRag(
                pinnedDiscussionText,
                MAX_SELECTION_RAG_TEXT_LENGTH
              )

              return window.desktop.translator.translate({
                text: [
                  `===== 用户固定讨论的原文（第 ${currentPage} 页）开始 =====`,
                  selectedContext,
                  '===== 用户固定讨论的原文结束 =====',
                  retrievedContext,
                  webContext,
                  '===== 用户最新问题 =====',
                  question
                ].filter(Boolean).join('\n'),
                targetLanguage: 'zh',
                action: 'selection-rag',
                webSearchEnabled: shouldSearchWeb && webResults.length > 0
              })
            })()
          : chatScope === 'document'
          ? await (async (): Promise<{ content: string; thinking?: string }> => {
              if (!isRagReady) {
                throw new Error('全文检索索引尚未建立完成')
              }

              const matches = await window.desktop.rag.search({
                filePath: activePdf.filePath,
                query: question,
                limit: 5
              })
              if (matches.length === 0) {
                throw new Error('未找到当前 PDF 的全文检索索引')
              }

              const retrievedContext = matches
                .map(
                  (match, index) => [
                    `===== 检索片段 ${index + 1}（第 ${match.pageNumber} 页）开始 =====`,
                    match.text,
                    `===== 检索片段 ${index + 1}（第 ${match.pageNumber} 页）结束 =====`
                  ].join('\n')
                )
                .join('\n\n')
              const discussionContext = activeDiscussionText
                ? [
                    '===== 用户固定讨论的原文 =====',
                    activeDiscussionText,
                    '===== 用户固定讨论的原文结束 ====='
                  ].join('\n')
                : ''

              return window.desktop.translator.translate({
                text: [
                  retrievedContext,
                  discussionContext,
                  webContext,
                  '===== 用户最新问题 =====',
                  question
                ].filter(Boolean).join('\n'),
                targetLanguage: 'zh',
                action: 'rag',
                webSearchEnabled: shouldSearchWeb && webResults.length > 0
              })
            })()
          : await (async (): Promise<{ content: string; thinking?: string }> => {
            // 旧记录仍会保留和显示，但只有当前页消息可进入本次模型上下文。
            const currentPageHistory = messagesBeforeAnswer
              .filter(
                (message) => message.pageNumber === currentPage
              )
              .slice(-10)
            const recentHistory = currentPageHistory
              .map((message) => {
                const role =
                  message.role === 'user' ? '用户' : 'AI'
                return `${role}：${message.content}`
              })
              .join('\n')
            const selectedContext = activeDiscussionText
              ? `\n用户当前固定讨论的原文：\n${activeDiscussionText}\n`
              : ''
            const promptText = [
              `===== 第 ${currentPage} 页 PDF 结构化原文开始 =====`,
              createStructuredPageContent(currentPageBlocks),
              `===== 第 ${currentPage} 页 PDF 结构化原文结束 =====`,
              selectedContext,
              webContext,
              '===== 对话记录 =====',
              recentHistory,
              '===== 用户最新问题 =====',
              question
            ].join('\n')

            return window.desktop.translator.translate({
              text: promptText,
              targetLanguage: 'zh',
              action: 'explain',
              webSearchEnabled: shouldSearchWeb && webResults.length > 0
            })
          })()

      const assistantMessage: ChatMessage = {
        id: `${Date.now()}-assistant`,
        role: 'assistant',
        content: reply.content,
        thinking: reply.thinking,
        action: useVision ? 'vision' : 'chat',
        createdAt: Date.now(),
        pageNumber: currentPage || undefined,
        webSources: webResults.length > 0 ? webResults : undefined
      }
      const completedMessages = [
        ...messagesBeforeAnswer,
        assistantMessage
      ]

      setChatMessages(completedMessages)
      saveConversation(activePdf, completedMessages)
    } catch (error) {
      console.error('AI 对话请求失败', error)
      setAiError(
        `AI 请求失败：${getErrorMessage(error)}`
      )
    } finally {
      setIsAiLoading(false)
      setAiProgress('')
    }
  }

  const runSelectedTextAction = async (
    action: 'translate' | 'explain'
  ): Promise<void> => {
    const sourceText = selectedText.trim()

    if (!sourceText || !activePdf || isAiLoading || isRendering) {
      return
    }

    const actionLabel =
      action === 'translate' ? '翻译选中文本' : '解释选中文本'
    const userMessage: ChatMessage = {
      id: `${Date.now()}-user`,
      role: 'user',
      content: actionLabel,
      action,
      createdAt: Date.now(),
      pageNumber: currentPage || undefined,
      sourceText
    }
    const messagesBeforeAnswer = [...chatMessages, userMessage]

    setChatMessages(messagesBeforeAnswer)
    setAiError('')
    setIsAiLoading(true)
    setSelectionMenuPosition(null)

    try {
      const reply = await window.desktop.translator.translate({
        text:
          action === 'translate'
            ? sourceText
            : [
                `===== 第 ${currentPage} 页 PDF 结构化原文开始 =====`,
                createStructuredPageContent([
                  {
                    id: 1,
                    column: 'single',
                    x: 0,
                    y: 0,
                    width: 100,
                    height: 100,
                    text: sourceText
                  }
                ]),
                `===== 第 ${currentPage} 页 PDF 结构化原文结束 =====`,
                '===== 用户最新问题 =====',
                '请讲解用户选中的这段内容。按以下顺序直接输出：\n1. 翻译：给出完整、自然的简体中文译文。\n2. 词汇与概念：解释关键术语、专业概念和重要表达。\n3. 文段逻辑：说明这段话的论点、依据、结论及其衔接关系。\n不要重复任务说明，也不要输出内部提示词或思考过程。'
              ].join('\n'),
        targetLanguage: 'zh',
        action,
        prompt:
          action === 'translate'
            ? '将用户选中的文本完整翻译为简体中文，只输出译文。'
            : undefined
      })

      const assistantMessage: ChatMessage = {
        id: `${Date.now()}-assistant`,
        role: 'assistant',
        content: reply.content,
        thinking: reply.thinking,
        action,
        createdAt: Date.now(),
        pageNumber: currentPage || undefined,
        sourceText
      }
      const completedMessages = [
        ...messagesBeforeAnswer,
        assistantMessage
      ]

      setChatMessages(completedMessages)
      saveConversation(activePdf, completedMessages)
    } catch (error) {
      console.error('选中文本 AI 请求失败', error)
      setAiError(`AI 请求失败：${getErrorMessage(error)}`)
    } finally {
      setIsAiLoading(false)
    }
  }

  const startDiscussionWithSelectedText = (): void => {
    const sourceText = selectedText.trim()
    if (!sourceText) {
      return
    }

    // 固定选区后再把焦点交给输入框；这样点击其他位置不会清空讨论上下文。
    setDiscussionText(sourceText)
    setSelectionMenuPosition(null)
    window.requestAnimationFrame(() => {
      chatInputRef.current?.focus()
    })
  }

  const startDiscussionWithSelectedChatText = (): void => {
    const sourceText = chatSelectionText.trim()
    if (!sourceText) {
      return
    }

    // 将 AI 对话中的选中文字复用为固定讨论上下文，下一次发送会优先使用它。
    setDiscussionText(sourceText)
    setChatSelectionText('')
    setChatSelectionMenuPosition(null)
    window.requestAnimationFrame(() => {
      chatInputRef.current?.focus()
    })
  }

  // const copySelectedChatText = async (): Promise<void> => {
  //   const sourceText = chatSelectionText.trim()
  //   if (!sourceText) {
  //     return
  //   }

  //   try {
  //     await navigator.clipboard.writeText(sourceText)
  //     setChatSelectionMenuPosition(null)
  //   } catch (error) {
  //     console.error('复制 AI 对话内容失败', error)
  //     setAiError('复制失败，请使用 Ctrl+C 复制选中的内容。')
  //   }
  // }

// 监听键盘事件：左右箭头翻页，输入框/下拉框/文本域中不触发翻页
useEffect(() => {
  const handleKeyDown = (event: KeyboardEvent): void => {
    if (!activePdf || isRendering) {
      return
    }

    const target = event.target

  if (
    target instanceof HTMLInputElement ||
    target instanceof HTMLSelectElement ||
    target instanceof HTMLTextAreaElement
  ) {
    return
  }

    if (event.key === 'ArrowLeft') {
      void goToPreviousPage()
    }

    if (event.key === 'ArrowRight') {
      void goToNextPage()
    }
  }

  window.addEventListener('keydown', handleKeyDown)

  return () => {
    window.removeEventListener('keydown', handleKeyDown)
  }
}, [
  activePdf,
  isRendering,
  currentPage,
  totalPages,
  scale
])
// 监听文本选中事件，获取当前选中的文本内容
useEffect(() => {
  const handleSelectionChange = (): void => {
    const selection = window.getSelection()
    const textLayer = textLayerRef.current
    const anchorNode = selection?.anchorNode
    const anchorElement =
      anchorNode instanceof Element
        ? anchorNode
        : anchorNode?.parentElement
    const chatMessage = anchorElement?.closest(
      '[data-chat-selectable="true"]'
    )

    if (
      selection &&
      selection.rangeCount > 0 &&
      chatMessage
    ) {
      const chatText = selection.toString().trim()
      setSelectedText('')
      setSelectionMenuPosition(null)
      setChatSelectionText(chatText)

      if (!chatText) {
        setChatSelectionMenuPosition(null)
        return
      }

      const selectionRect = selection
        .getRangeAt(0)
        .getBoundingClientRect()
      setChatSelectionMenuPosition({
        left: Math.max(
          8,
          Math.min(selectionRect.left, window.innerWidth - 240)
        ),
        top: Math.max(8, selectionRect.top - 42)
      })
      return
    }

    if (
      !selection ||
      selection.rangeCount === 0 ||
      !textLayer ||
      !anchorNode ||
      !textLayer.contains(anchorNode)
    ) {
      setSelectedText('')
      setSelectionMenuPosition(null)
      setChatSelectionText('')
      setChatSelectionMenuPosition(null)
      return
    }

    const range = selection.getRangeAt(0)

    const selectedText = getSelectedTextFromRange(
      textLayer,
      range
    )

    setChatSelectionText('')
    setChatSelectionMenuPosition(null)
    setSelectedText(selectedText)

    if (!selectedText) {
      setSelectionMenuPosition(null)
      return
    }

    const selectionRect = range.getBoundingClientRect()
    setSelectionMenuPosition({
      left: Math.max(
        8,
        Math.min(selectionRect.left, window.innerWidth - 270)
      ),
      top: Math.max(8, selectionRect.top - 42)
    })
  }

  document.addEventListener(
    'selectionchange',
    handleSelectionChange
  )

  return () => {
    document.removeEventListener(
      'selectionchange',
      handleSelectionChange
    )
  }
}, [])

// 批注数据从 localStorage 载入或新增后，重新给当前文本层中的对应文字加虚线。
useEffect(() => {
  const textLayer = textLayerRef.current
  if (!textLayer || currentPage === 0) {
    return
  }

  applyAnnotationMarkers(textLayer, currentPage, annotations)
}, [annotations, currentPage])

const currentPageImageAnnotations = annotations.filter(
  (annotation) =>
    annotation.kind === 'image' &&
    annotation.pageNumber === currentPage &&
    isValidImageSelection(annotation.imageSelection)
)

  return (
    // 根容器，占满整个窗口，纵向flex布局
    <div
      style={{
        height: '100vh',
        width: '100vw',
        display: 'flex',
        flexDirection: 'column',
        background: '#f5f5f5',
        color: '#111827'
      }}
    >
      {/* 顶部标题栏 */}
      <header
        style={{
          height: '48px',
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          padding: '0 16px',
          borderBottom: '1px solid #ddd',
          background: '#ffffff',
          fontWeight: 600
        }}
      >
        AI PDF Reader
      </header>

      {selectionMenuPosition && selectedText && activePdf && (
        <div
          style={{
            position: 'fixed',
            left: `${selectionMenuPosition.left}px`,
            top: `${selectionMenuPosition.top}px`,
            zIndex: 1000,
            display: 'flex',
            gap: '6px',
            padding: '6px',
            borderRadius: '6px',
            background: '#111827',
            boxShadow: '0 4px 12px rgba(0, 0, 0, 0.22)'
          }}
          // 点击菜单时保持浏览器选区，避免在触发请求前丢失文本。
          onMouseDown={(event) => event.preventDefault()}
        >
          <button
            onClick={() => void runSelectedTextAction('translate')}
            disabled={isAiLoading || isRendering}
          >
            翻译
          </button>
          <button
            onClick={() => void runSelectedTextAction('explain')}
            disabled={isAiLoading || isRendering}
          >
            解释
          </button>
          <button
            onClick={startDiscussionWithSelectedText}
            disabled={isAiLoading || isRendering}
          >
            小易对话
          </button>
          <button
            onClick={startAnnotationForSelectedText}
            disabled={isRendering}
          >
            添加批注
          </button>
        </div>
      )}

      {chatSelectionMenuPosition && chatSelectionText && activePdf && (
        <div
          style={{
            position: 'fixed',
            left: `${chatSelectionMenuPosition.left}px`,
            top: `${chatSelectionMenuPosition.top}px`,
            zIndex: 1000,
            display: 'flex',
            gap: '6px',
            padding: '6px',
            borderRadius: '6px',
            background: '#111827',
            boxShadow: '0 4px 12px rgba(0, 0, 0, 0.22)'
          }}
          // 点击菜单时保留对话文字选区，避免点击按钮后选区立即消失。
          onMouseDown={(event) => event.preventDefault()}
        >
          <button
            onClick={startDiscussionWithSelectedChatText}
            disabled={isAiLoading || isRendering}
          >
            小易对话
          </button>
        </div>
      )}

      {isAnnotationEditorOpen && activePdf && (
        <div
          role="presentation"
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 1100,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '16px',
            background: 'rgba(17, 24, 39, 0.35)'
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label="添加 PDF 批注"
            style={{
              width: 'min(520px, 100%)',
              padding: '16px',
              borderRadius: '8px',
              background: '#ffffff',
              boxShadow: '0 12px 36px rgba(0, 0, 0, 0.24)'
            }}
          >
            <h3 style={{ margin: '0 0 8px' }}>添加批注</h3>
            <p
              style={{
                margin: '0 0 12px',
                color: '#4b5563',
                fontSize: '13px',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                userSelect: 'text',
                WebkitUserSelect: 'text'
              }}
            >
              {imageAnnotationSelection
                ? `已选择图片区域：${Math.round(imageAnnotationSelection.width * 100)}% × ${Math.round(imageAnnotationSelection.height * 100)}%`
                : annotationSourceText.length > 280
                  ? `${annotationSourceText.slice(0, 280)}…`
                  : annotationSourceText}
            </p>
            <textarea
              autoFocus
              value={annotationDraft}
              onChange={(event) => setAnnotationDraft(event.target.value)}
              placeholder="输入你的评论、疑问或阅读笔记…"
              rows={5}
              style={{
                width: '100%',
                boxSizing: 'border-box',
                resize: 'vertical'
              }}
            />
            <div
              style={{
                display: 'flex',
                justifyContent: 'flex-end',
                gap: '8px',
                marginTop: '12px'
              }}
            >
              <button
                onClick={() => {
                  setIsAnnotationEditorOpen(false)
                  setAnnotationSourceText('')
                  setImageAnnotationSelection(null)
                  setAnnotationDraft('')
                }}
              >
                取消
              </button>
              <button
                onClick={saveAnnotation}
                disabled={!annotationDraft.trim()}
              >
                保存批注
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 三栏面板容器，占满剩余高度 */}
      <div
        style={{
          flex: 1,
          minHeight: 0
        }}
      >
        {/* 水平可拖拽面板分组 */}
        <Group orientation="horizontal">
          {/* 左侧 Documents 文档面板 */}
          <Panel
            defaultSize="15%"
            minSize="10%"
          >
            <div
              style={{
                height: '100%',
                padding: '16px',
                boxSizing: 'border-box',
                background: '#fafafa'
              }}
            >
              <h3>Documents</h3>
              <button
                onClick={openPdf}
                style={{
                  padding: '8px 12px',
                  cursor: 'pointer'
                }}
              >
                打开 PDF
              </button>
              {/* 已打开PDF则显示文件名 */}
              {activePdf && (
                <div
                  style={{
                    marginTop: '16px',
                    fontSize: '14px',
                    wordBreak: 'break-word'
                  }}
                >
                  {errorMessage && (
                    <div
                      style={{
                        padding: '12px',
                        marginBottom: '12px',
                        color: '#991b1b',
                        background: '#fee2e2',
                        border: '1px solid #fecaca',
                        borderRadius: '4px'
                      }}
                    >
                      {errorMessage}
                    </div>
                  )}
                  <button
                    onClick={() => void closePdf()}
                    style={{
                      marginTop: '8px',
                      padding: '8px 12px',
                      cursor: 'pointer'
                    }}
                  >
                    关闭 PDF
                  </button>
                  {activePdf.fileName}
                </div>
              )}
              <section
                style={{
                  marginTop: '20px',
                  paddingTop: '12px',
                  borderTop: '1px solid #e5e7eb'
                }}
              >
                <h4 style={{ margin: '0 0 8px' }}>AI 服务设置</h4>
                <label
                  style={{
                    display: 'block',
                    marginBottom: '8px',
                    fontSize: '12px'
                  }}
                >
                  使用方式
                  <select
                    value={aiBackend}
                    onChange={(event) => {
                      setAiBackend(event.target.value as AiBackend)
                      setAiConfigStatus('')
                      setAiConfigError('')
                    }}
                    style={{ width: '100%', marginTop: '4px' }}
                  >
                    <option value="ollama">本地 Ollama</option>
                    <option value="api">OpenAI 兼容 API</option>
                  </select>
                </label>

                {aiBackend === 'api' && (
                  <div
                    style={{
                      padding: '8px',
                      marginBottom: '12px',
                      background: '#f0fdf4',
                      border: '1px solid #bbf7d0',
                      borderRadius: '4px'
                    }}
                  >
                    <label
                      style={{
                        display: 'block',
                        marginBottom: '6px',
                        fontSize: '12px'
                      }}
                    >
                      API 地址
                      <input
                        value={apiBaseUrl}
                        onChange={(event) => setApiBaseUrl(event.target.value)}
                        placeholder="https://api.example.com/v1"
                        style={{
                          width: '100%',
                          boxSizing: 'border-box',
                          marginTop: '3px',
                          fontSize: '12px'
                        }}
                      />
                    </label>
                    <label
                      style={{
                        display: 'block',
                        marginBottom: '6px',
                        fontSize: '12px'
                      }}
                    >
                      API Key
                      <input
                        type="password"
                        value={apiKeyInput}
                        onChange={(event) => setApiKeyInput(event.target.value)}
                        placeholder={
                          apiKeySet ? '已保存，留空表示保持不变' : '请输入 API Key'
                        }
                        style={{
                          width: '100%',
                          boxSizing: 'border-box',
                          marginTop: '3px',
                          fontSize: '12px'
                        }}
                      />
                    </label>
                    <p
                      style={{
                        margin: '0 0 6px',
                        color: '#166534',
                        fontSize: '11px'
                      }}
                    >
                      每个功能单独保存自己的 API 模型；修改一项不会影响其他功能。
                    </p>
                    {API_MODEL_FIELDS.map((field) => (
                      <label
                        key={field.key}
                        style={{
                          display: 'block',
                          marginBottom: '6px',
                          fontSize: '12px'
                        }}
                      >
                        {field.label}
                        <input
                          value={apiModels[field.key]}
                          onChange={(event) => {
                            setApiModels((current) => ({
                              ...current,
                              [field.key]: event.target.value
                            }))
                          }}
                          placeholder={field.placeholder}
                          style={{
                            width: '100%',
                            boxSizing: 'border-box',
                            marginTop: '3px',
                            fontSize: '12px'
                          }}
                        />
                      </label>
                    ))}
                    <button
                      onClick={() => void saveAiConfig()}
                      disabled={!apiBaseUrl.trim()}
                      style={{ marginTop: '2px', fontSize: '12px' }}
                    >
                      保存 API 配置
                    </button>
                    <p
                      style={{
                        margin: '6px 0 0',
                        color: '#166534',
                        fontSize: '11px'
                      }}
                    >
                      API Key 只在主进程中使用，并以系统安全存储加密保存。
                    </p>
                  </div>
                )}
                {aiBackend === 'ollama' && (
                  <button
                    onClick={() => void saveAiConfig()}
                    style={{ marginBottom: '8px', fontSize: '12px' }}
                  >
                    保存并使用本地 Ollama
                  </button>
                )}

                {aiConfigStatus && (
                  <p style={{ margin: '0 0 8px', color: '#166534', fontSize: '12px' }}>
                    {aiConfigStatus}
                  </p>
                )}
                {aiConfigError && (
                  <p style={{ margin: '0 0 8px', color: '#b91c1c', fontSize: '12px' }}>
                    {aiConfigError}
                  </p>
                )}

                <h4 style={{ margin: '12px 0 8px' }}>
                  {aiBackend === 'ollama' ? '本地 AI 模型' : '本地模型（可选）'}
                </h4>
                {aiBackend === 'api' ? (
                  <p style={{ margin: 0, color: '#6b7280', fontSize: '12px' }}>
                    当前请求使用 API，本地模型不需要下载。Embedding 模型用于全文 RAG；视觉模型用于流程图、实验图和表格理解。
                  </p>
                ) : (
                  <>
                {modelError && (
                  <p style={{ margin: '0 0 8px', color: '#b91c1c', fontSize: '12px' }}>
                    {modelError}
                  </p>
                )}
                {!localModelState && !modelError && (
                  <p style={{ margin: 0, color: '#6b7280', fontSize: '12px' }}>
                    正在读取本地模型…
                  </p>
                )}
                {localModelState && (
                  (['translation', 'chat', 'vision'] as ModelRole[]).map((role) => (
                    <div key={role} style={{ marginBottom: '12px' }}>
                      <strong style={{ fontSize: '13px' }}>
                        {role === 'translation'
                          ? '翻译'
                          : role === 'chat'
                            ? '讲解与问答'
                            : '视觉识图（准备）'}
                      </strong>
                      {localModelState.candidates
                        .filter((candidate) => candidate.role === role)
                        .map((candidate) => {
                          const installed = localModelState.installedModelIds.includes(
                            candidate.id
                          )
                          const selected = localModelState.preferences[role] === candidate.id
                          const downloading =
                            activeModelOperation === `download:${candidate.id}`
                          const selecting =
                            activeModelOperation === `select:${candidate.id}`

                          return (
                            <div
                              key={candidate.id}
                              style={{
                                marginTop: '6px',
                                padding: '6px',
                                borderRadius: '4px',
                                background: selected ? '#eff6ff' : '#ffffff',
                                border: selected
                                  ? '1px solid #93c5fd'
                                  : '1px solid #e5e7eb'
                              }}
                            >
                              <div style={{ fontSize: '12px', fontWeight: 600 }}>
                                {candidate.label} · {candidate.size}
                              </div>
                              <div style={{ marginTop: '2px', fontSize: '11px', color: '#6b7280' }}>
                                {candidate.description}
                              </div>
                              {installed ? (
                                <button
                                  onClick={() => void selectModel(role, candidate.id)}
                                  disabled={selected || Boolean(activeModelOperation)}
                                  style={{ marginTop: '5px', fontSize: '12px' }}
                                >
                                  {selected
                                    ? '当前使用中'
                                    : selecting
                                      ? '正在切换…'
                                      : '设为默认'}
                                </button>
                              ) : (
                                <button
                                  onClick={() => void downloadModel(candidate.id)}
                                  disabled={Boolean(activeModelOperation)}
                                  style={{ marginTop: '5px', fontSize: '12px' }}
                                >
                                  {downloading ? '正在下载…' : '下载'}
                                </button>
                              )}
                            </div>
                          )
                        })}
                      <div
                        style={{
                          marginTop: '6px',
                          paddingTop: '6px',
                          borderTop: '1px dashed #d1d5db'
                        }}
                      >
                        <input
                          value={customModelIds[role]}
                          onChange={(event) => {
                            setCustomModelIds((current) => ({
                              ...current,
                              [role]: event.target.value
                            }))
                          }}
                          placeholder={
                            role === 'translation'
                              ? '例如：translategemma:12b'
                              : role === 'chat'
                                ? '例如：qwen3:8b'
                                : '例如：qwen3-vl:4b'
                          }
                          disabled={Boolean(activeModelOperation)}
                          style={{
                            width: '100%',
                            boxSizing: 'border-box',
                            fontSize: '12px'
                          }}
                        />
                        <button
                          onClick={() => void downloadAndSelectCustomModel(role)}
                          disabled={
                            !customModelIds[role].trim() ||
                            Boolean(activeModelOperation)
                          }
                          style={{ marginTop: '5px', fontSize: '12px' }}
                        >
                          {activeModelOperation === `custom:${role}`
                            ? '正在下载并设为默认…'
                            : '输入模型并自动下载'}
                        </button>
                      </div>
                    </div>
                  ))
                )}
                  </>
                )}
              </section>
              {/* {activePdf && currentPageText && (
                <details
                  style={{
                    marginTop: '16px',
                    textAlign: 'left',
                    background: '#ffffff',
                    padding: '12px'
                  }}
                >
                  <summary>查看当前页文本</summary>
                  <p style={{ whiteSpace: 'pre-wrap' }}>
                    {currentPageText}
                  </p>
                </details>
              )} */}
              {!activePdf && (
                <div
                  style={{
                    padding: '40px',
                    color: '#6b7280',
                    textAlign: 'center'
                  }}
                >
                  请先从左侧打开一个 PDF 文件
                </div>
              )}
            </div>
          </Panel>

          {/* 面板分割拖拽条 */}
          <Separator
            style={{
              width: '4px',
              background: '#dddddd',
              cursor: 'col-resize'
            }}
          />

          {/* 中间 PDF预览面板 */}
          <Panel
            defaultSize="55%"
            minSize="30%"
          >
            <div
              style={{
                height: '100%',
                display: 'flex',
                flexDirection: 'column',
                background: '#e5e7eb'
              }}
            >
              {/* PDF工具栏：翻页、缩放、状态信息 */}
              <div
                style={{
                  height: '48px',
                  flexShrink: 0,
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                  padding: '0 12px',
                  background: '#ffffff',
                  borderBottom: '1px solid #ddd',
                  fontSize: '13px'
                }}
              >
                {/* 上一页按钮 */}
                <button
                  onClick={goToPreviousPage}
                  disabled={
                    !activePdf ||
                    currentPage <= 1 ||
                    isRendering
                  }
                >
                  上一页
                </button>
                {/* 页码显示区域 */}
                <span
                  style={{
                    minWidth: '90px',
                    textAlign: 'center'
                  }}
                >
                  {activePdf
                    ? `第 ${currentPage} / ${totalPages} 页`
                    : '未打开 PDF'}
                </span>
                {/* 下一页按钮 */}
                <button
                  onClick={goToNextPage}
                  disabled={
                    !activePdf ||
                    currentPage >= totalPages ||
                    isRendering
                  }
                >
                  下一页
                </button>

                {/* 工具栏内部分隔线 */}
                <div
                  style={{
                    width: '1px',
                    height: '24px',
                    background: '#dddddd',
                    margin: '0 6px'
                  }}
                />

                {/* 缩小按钮 */}
                <button
                  onClick={zoomOut}
                  disabled={
                    !activePdf ||
                    isRendering ||
                    scale <= 0.5
                  }
                >
                  −
                </button>
                {/* 显示当前缩放百分比，点击重置100% */}
                <button
                  onClick={resetZoom}
                  disabled={!activePdf || isRendering}
                  title="恢复 100%"
                  style={{
                    minWidth: '60px'
                  }}
                >
                  {Math.round(scale * 100)}%
                </button>
                {/* 放大按钮 */}
                <button
                  onClick={zoomIn}
                  disabled={
                    !activePdf ||
                    isRendering ||
                    scale >= 2.5
                  }
                >
                  +
                </button>

                {/* 右侧文件名状态，文字超长省略 */}
                <span
                  style={{
                    marginLeft: 'auto',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap'
                  }}
                >
                  {isRendering
                    ? '正在渲染...'
                    : pdfStatus}
                </span>
              </div>

              {/* PDF画布容器，内容溢出滚动 */}
              <div
                style={{
                  flex: 1,
                  minHeight: 0,
                  overflow: 'auto',
                  padding: '24px',
                  textAlign: 'center'
                }}
              >
                {/* canvas画布，pdfjs渲染PDF页面载体 */}
              <div
                style={{
                  position: 'relative',
                  zIndex: 0,
                  display: activePdf ? 'inline-block' : 'none',
                  // width: canvasRef.current?.style.width,
                  // height: canvasRef.current?.style.height,
                  background: '#ffffff',
                  boxShadow: '0 2px 10px rgba(0,0,0,0.15)'
                }}
              >
                <canvas
                  ref={canvasRef}
                  style={{
                    display: 'block'
                  }}
                />

                <div
                  ref={textLayerRef}
                  className="textLayer"
                />

                {/* 图片理解开启后，拖拽此透明层框选流程图、表格或实验图。 */}
                {(isVisionMode || currentPageImageAnnotations.length > 0) && (
                  <div
                    aria-label="拖拽框选需要图片理解的区域"
                    onPointerDown={handleImageSelectionPointerDown}
                    onPointerMove={handleImageSelectionPointerMove}
                    onPointerUp={finishImageSelection}
                    onPointerCancel={cancelImageSelection}
                    style={{
                      position: 'absolute',
                      left: 0,
                      top: 0,
                      width: '100%',
                      height: '100%',
                      zIndex: 10,
                      cursor: isVisionMode ? 'crosshair' : 'default',
                      touchAction: 'none',
                      userSelect: 'none',
                      WebkitUserSelect: 'none',
                      pointerEvents: isVisionMode ? 'auto' : 'none'
                    }}
                  >
                    {currentPageImageAnnotations.map((annotation) => {
                      const selection = annotation.imageSelection
                      if (!selection) {
                        return null
                      }

                      return (
                        <div
                          key={annotation.id}
                          title={`图片批注：${annotation.comment}`}
                          style={{
                            position: 'absolute',
                            left: `${selection.left * 100}%`,
                            top: `${selection.top * 100}%`,
                            width: `${selection.width * 100}%`,
                            height: `${selection.height * 100}%`,
                            boxSizing: 'border-box',
                            border: '2px dotted #d97706',
                            background: 'rgba(245, 158, 11, 0.08)',
                            pointerEvents: 'none'
                          }}
                        />
                      )
                    })}
                    {isVisionMode && imageSelection && (
                      <div
                        style={{
                          position: 'absolute',
                          left: `${imageSelection.left * 100}%`,
                          top: `${imageSelection.top * 100}%`,
                          width: `${imageSelection.width * 100}%`,
                          height: `${imageSelection.height * 100}%`,
                          boxSizing: 'border-box',
                          border: '2px solid #2563eb',
                          background: 'rgba(37, 99, 235, 0.12)',
                          pointerEvents: 'none'
                        }}
                      />
                    )}
                    {isVisionMode && <div
                      style={{
                        position: 'absolute',
                        right: '8px',
                        bottom: '8px',
                        padding: '4px 6px',
                        borderRadius: '4px',
                        background: 'rgba(17, 24, 39, 0.78)',
                        color: '#ffffff',
                        fontSize: '12px',
                        pointerEvents: 'none'
                      }}
                    >
                      {imageSelection
                        ? `已选图片区域：${Math.round(imageSelection.width * 100)}% × ${Math.round(imageSelection.height * 100)}%`
                        : '拖拽框选图片；未框选时分析整页'}
                    </div>}
                  </div>
                )}
              </div>
              </div>
            </div>
          </Panel>

          {/* 分割条 */}
          <Separator
            style={{
              width: '4px',
              background: '#dddddd',
              cursor: 'col-resize'
            }}
          />

          {/* 右侧 AI Chat 面板 */}
          <Panel
            defaultSize="30%"
            minSize="20%"
          >
            <div
              style={{
                height: '100%',
                padding: '16px',
                boxSizing: 'border-box',
                background: '#fafafa'
              }}
            >
            <div
              style={{
                height: '100%',
                display: 'flex',
                flexDirection: 'column',
                background: '#fafafa'
              }}
            >
              <section
                style={{
                  flex: 1,
                  minHeight: 0,
                  padding: '16px',
                  overflow: 'auto',
                  borderBottom: '1px solid #ddd'
                }}
              >
                <h3>AI 对话</h3>

                <button
                  onClick={() => void sendChatMessage('翻译当前页', true)}
                  disabled={
                    !activePdf ||
                    !currentPageText ||
                    currentPageAllBlocks.length === 0 ||
                    isAiLoading ||
                    isRendering
                  }
                  title="使用 TranslateGemma 完整翻译当前 PDF 页面"
                  style={{ marginBottom: '12px' }}
                >
                  翻译当前页
                </button>

                {activePdf && (
                  <details style={{ marginBottom: '12px' }}>
                    <summary style={{ cursor: 'pointer', fontWeight: 600 }}>
                      PDF 批注（{annotations.length}）
                    </summary>
                    <div
                      style={{
                        maxHeight: '180px',
                        marginTop: '8px',
                        overflow: 'auto'
                      }}
                    >
                      {annotations.length === 0 ? (
                        <p style={{ margin: 0, color: '#6b7280', fontSize: '13px' }}>
                          选中文段后点击“添加批注”，你的评论会保存在本机。
                        </p>
                      ) : (
                        annotations.map((annotation) => (
                          <div
                            key={annotation.id}
                            style={{
                              marginBottom: '8px',
                              padding: '8px',
                              border: '1px solid #fde68a',
                              borderRadius: '6px',
                              background: '#fffbeb'
                            }}
                          >
                            <div
                              style={{
                                display: 'flex',
                                justifyContent: 'space-between',
                                gap: '8px',
                                color: '#92400e',
                                fontSize: '12px'
                              }}
                            >
                              <span>第 {annotation.pageNumber} 页</span>
                              <button
                                onClick={() => deleteAnnotation(annotation.id)}
                                style={{ fontSize: '12px' }}
                              >
                                删除
                              </button>
                            </div>
                            <div
                              style={{
                                margin: '4px 0',
                                color: '#6b7280',
                                fontSize: '12px',
                                whiteSpace: 'pre-wrap',
                                wordBreak: 'break-word',
                                userSelect: 'text',
                                WebkitUserSelect: 'text'
                              }}
                            >
                              {annotation.kind === 'image'
                                ? '图片区域批注'
                                : (annotation.selectedText ?? '').length > 120
                                  ? `${(annotation.selectedText ?? '').slice(0, 120)}…`
                                  : annotation.selectedText}
                            </div>
                            <div
                              style={{
                                whiteSpace: 'pre-wrap',
                                wordBreak: 'break-word',
                                userSelect: 'text',
                                WebkitUserSelect: 'text'
                              }}
                            >
                              {annotation.comment}
                            </div>
                          </div>
                        ))
                      )}
                    </div>
                  </details>
                )}

                {activePdf && currentPageText && (
                  <p style={{ color: '#6b7280' }}>
                    已读取第 {currentPage} 页：{currentPageText.length} 个字符
                  </p>
                )}

                {activePdf && (
                  <>
                    <label
                      style={{
                        display: 'block',
                        marginBottom: '8px',
                        fontSize: '14px'
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={isVisionMode}
                        disabled={isAiLoading || !isVisionAvailable}
                        onChange={(event) => {
                          setIsVisionMode(event.target.checked)
                          cancelImageSelection()
                          setAiError('')
                        }}
                      />{' '}
                      图片理解（可框选图片）
                    </label>
                    {isVisionMode ? (
                      <p
                        style={{
                          margin: '0 0 8px',
                          color: '#6b7280',
                          fontSize: '12px'
                        }}
                      >
                        在 PDF 页面上拖拽框选流程图、表格或实验图；
                        {imageSelection
                          ? '本次只发送已框选图片。'
                          : '未框选时会发送整页图片。'}
                        {aiBackend === 'api'
                          ? apiModels.vision
                            ? ` 当前 API 模型：${apiModels.vision}。`
                            : ' 当前未配置 API 视觉模型。'
                          : visionModelId
                            ? ` 当前模型：${visionModelId}。`
                            : ''}
                      </p>
                    ) : !isVisionAvailable ? (
                      <p
                        style={{
                          margin: '0 0 8px',
                          color: '#92400e',
                          fontSize: '12px'
                        }}
                      >
                        {aiBackend === 'api'
                          ? '图片理解需要在左侧 AI 服务设置中填写视觉模型名称。'
                          : '图片理解需要在左侧“本地 AI 模型”中下载并设定视觉模型。'}
                      </p>
                    ) : null}
                    {isVisionMode && imageSelection && (
                      <div style={{ marginBottom: '8px' }}>
                        <button
                          onClick={startAnnotationForImageSelection}
                          disabled={isAiLoading || isRendering}
                          style={{ marginRight: '8px' }}
                        >
                          给当前图片添加批注
                        </button>
                        <button
                          onClick={cancelImageSelection}
                          disabled={isAiLoading}
                        >
                          清除图片选区（改为整页）
                        </button>
                      </div>
                    )}
                    <label
                      style={{
                        display: 'block',
                        marginBottom: '8px',
                        fontSize: '14px'
                      }}
                    >
                      问答范围
                      <select
                        value={chatScope}
                        onChange={(event) => {
                          setChatScope(
                            event.target.value === 'document'
                              ? 'document'
                              : 'page'
                          )
                        }}
                        disabled={isAiLoading || isVisionMode}
                        style={{ marginLeft: '8px' }}
                      >
                        <option value="document">整份文档（RAG 检索）</option>
                        <option value="page">当前页</option>
                      </select>
                    </label>
                    {ragStatus && (
                      <p
                        style={{
                          margin: '0 0 8px',
                          color: isRagReady ? '#166534' : '#6b7280',
                          fontSize: '12px'
                        }}
                      >
                        {ragStatus}
                      </p>
                    )}
                    <label
                      style={{
                        display: 'block',
                        marginBottom: '8px',
                        fontSize: '14px'
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={isWebSearchEnabled}
                        disabled={isAiLoading || isVisionMode}
                        onChange={(event) => {
                          setIsWebSearchEnabled(event.target.checked)
                          setWebSearchStatus('')
                        }}
                      />{' '}
                      联网搜索（回答时检索网页）
                    </label>
                    {webSearchStatus && (
                      <p
                        style={{
                          margin: '0 0 8px',
                          color: webSearchStatus.startsWith('联网搜索失败')
                            ? '#b91c1c'
                            : '#2563eb',
                          fontSize: '12px'
                        }}
                      >
                        {webSearchStatus}
                      </p>
                    )}
                    <label
                      style={{
                        display: 'block',
                        marginBottom: '8px',
                        fontSize: '14px'
                      }}
                    >
                      搜索接口
                      <select
                        value={webSearchProvider}
                        onChange={(event) => {
                          setWebSearchProvider(
                            event.target.value === 'duckduckgo'
                              ? 'duckduckgo'
                              : 'bing'
                          )
                          setWebSearchConfigStatus('')
                        }}
                        disabled={isAiLoading}
                        style={{ marginLeft: '8px' }}
                      >
                        <option value="bing">Bing（推荐）</option>
                        <option value="duckduckgo">DuckDuckGo</option>
                      </select>
                    </label>
                    <div style={{ marginBottom: '8px' }}>
                      <label
                        style={{
                          display: 'block',
                          marginBottom: '4px',
                          fontSize: '14px'
                        }}
                      >
                        代理地址
                        <input
                          value={webProxyAddress}
                          onChange={(event) => {
                            setWebProxyAddress(event.target.value)
                            setWebSearchConfigStatus('')
                          }}
                          placeholder="例如 http://127.0.0.1:7890"
                          disabled={isAiLoading}
                          style={{
                            width: '100%',
                            marginTop: '4px',
                            boxSizing: 'border-box',
                            fontSize: '12px'
                          }}
                        />
                      </label>
                      <p
                        style={{
                          margin: '0 0 4px',
                          color: '#6b7280',
                          fontSize: '12px'
                        }}
                      >
                        留空使用系统代理；支持 http、https、socks4、socks5。
                      </p>
                      <button
                        onClick={() => void saveWebSearchConfig()}
                        disabled={isAiLoading}
                        style={{ fontSize: '12px' }}
                      >
                        保存搜索配置
                      </button>
                    </div>
                    {webSearchConfigStatus && (
                      <p
                        style={{
                          margin: '0 0 8px',
                          color: '#166534',
                          fontSize: '12px'
                        }}
                      >
                        {webSearchConfigStatus}
                      </p>
                    )}
                    {webSearchConfigError && (
                      <p
                        style={{
                          margin: '0 0 8px',
                          color: '#b91c1c',
                          fontSize: '12px'
                        }}
                      >
                        {webSearchConfigError}
                      </p>
                    )}
                  </>
                )}

                {isAiLoading && (
                  <p>{aiProgress || 'AI 正在处理...'}</p>
                )}

                {aiError && (
                  <p style={{ color: '#b91c1c' }}>
                    {aiError}
                  </p>
                )}

                {chatMessages.map((message) => (
                  <div
                    key={message.id}
                    data-chat-selectable="true"
                    style={{
                      marginBottom: '10px',
                      padding: '8px',
                      borderRadius: '6px',
                      // 覆盖 body 的 user-select:none，让消息可以拖选和复制。
                      userSelect: 'text',
                      WebkitUserSelect: 'text',
                      cursor: 'text',
                      background:
                        message.role === 'user'
                          ? '#e0f2fe'
                          : '#ffffff'
                    }}
                  >
                    {message.pageNumber && (
                      <div
                        style={{
                          marginBottom: '4px',
                          color: '#6b7280',
                          fontSize: '12px'
                        }}
                      >
                        第 {message.pageNumber} 页
                      </div>
                    )}
                    {message.content}
                    {message.role === 'assistant' &&
                      message.webSources &&
                      message.webSources.length > 0 && (
                        <div
                          style={{
                            marginTop: '8px',
                            fontSize: '12px',
                            color: '#6b7280'
                          }}
                        >
                          <div style={{ marginBottom: '3px' }}>
                            联网来源：
                          </div>
                          {message.webSources.map((source, index) => (
                            <a
                              key={`${message.id}-web-${index}`}
                              href={source.url}
                              target="_blank"
                              rel="noreferrer"
                              style={{
                                display: 'block',
                                marginBottom: '2px',
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap'
                              }}
                              title={source.url}
                            >
                              [网页{index + 1}] {source.title}
                            </a>
                          ))}
                        </div>
                      )}
                  </div>
                ))}

                {discussionText && (
                  <div
                    style={{
                      marginBottom: '8px',
                      padding: '8px',
                      border: '1px solid #93c5fd',
                      borderRadius: '6px',
                      background: '#eff6ff',
                      fontSize: '13px'
                    }}
                  >
                    <div style={{ marginBottom: '4px', fontWeight: 600 }}>
                      正在讨论选中文本
                      <button
                        onClick={() => setDiscussionText('')}
                        disabled={isAiLoading}
                        style={{ float: 'right' }}
                        title="取消该选区的讨论上下文"
                      >
                        清除
                      </button>
                    </div>
                    <div
                      style={{
                        whiteSpace: 'pre-wrap',
                        wordBreak: 'break-word',
                        userSelect: 'text',
                        WebkitUserSelect: 'text'
                      }}
                    >
                      {discussionText.length > 180
                        ? `${discussionText.slice(0, 180)}…`
                        : discussionText}
                    </div>
                    {discussionText.length > MAX_SELECTION_RAG_TEXT_LENGTH && (
                      <p
                        style={{
                          margin: '6px 0 0',
                          color: '#92400e'
                        }}
                      >
                        选区较长；为保证回答稳定，本次讨论会使用前 {MAX_SELECTION_RAG_TEXT_LENGTH} 个字符。
                      </p>
                    )}
                  </div>
                )}

                <textarea
                  ref={chatInputRef}
                  value={chatInput}
                  onChange={(event) => {
                    setChatInput(event.target.value)
                  }}
                  placeholder="询问当前 PDF 内容..."
                  rows={3}
                  style={{
                    width: '100%',
                    boxSizing: 'border-box',
                    resize: 'vertical'
                  }}
                />

                <button
                  onClick={() => void sendChatMessage()}
                  disabled={
                    !chatInput.trim() ||
                    isAiLoading ||
                    isRendering ||
                    (isVisionMode && !isVisionAvailable) ||
                    (!isVisionMode &&
                      discussionText.trim().length > 0 &&
                      !isRagReady) ||
                    (!isVisionMode &&
                      chatScope === 'document' &&
                      !isRagReady)
                  }
                  style={{ marginTop: '8px' }}
                >
                  发送
                </button>
              </section>

            </div>
            {/* 关闭右侧面板的外层容器 */}
            </div>
          </Panel>
        </Group>
      </div>
    </div>
  )
}

export default App
