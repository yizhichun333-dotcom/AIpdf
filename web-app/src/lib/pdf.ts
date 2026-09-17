import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs'
import pdfWorker from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url'
import type { TextBlock } from './types'

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorker

export type PdfDocument = pdfjsLib.PDFDocumentProxy
export type PdfTextContent = Awaited<ReturnType<pdfjsLib.PDFPageProxy['getTextContent']>>

export const loadPdf = (data: ArrayBuffer): Promise<PdfDocument> =>
  pdfjsLib.getDocument({ data }).promise

export const renderTextLayer = async (
  textContent: PdfTextContent,
  container: HTMLDivElement,
  viewport: pdfjsLib.PageViewport
): Promise<void> => {
  container.replaceChildren()
  const layer = new pdfjsLib.TextLayer({
    textContentSource: textContent,
    container,
    viewport
  })
  await layer.render()
}

interface PositionedBlock extends TextBlock {
  centerX: number
}

const visualCompare = (left: PositionedBlock, right: PositionedBlock): number => {
  const yDelta = left.y - right.y
  const rowTolerance = Math.max(left.height, right.height) * 0.65
  return Math.abs(yDelta) > rowTolerance ? yDelta : left.x - right.x
}

const classifyColumns = (blocks: PositionedBlock[]): void => {
  const left = blocks.filter((block) => block.centerX < 47).length
  const right = blocks.filter((block) => block.centerX > 53).length
  const twoColumns = left >= 3 && right >= 3
  for (const block of blocks) {
    block.column = twoColumns && block.width < 40
      ? (block.centerX < 50 ? 'left' : 'right')
      : 'single'
  }
}

export const getPageBlocks = async (
  page: pdfjsLib.PDFPageProxy,
  viewport: pdfjsLib.PageViewport
): Promise<{ blocks: TextBlock[]; text: string; textContent: PdfTextContent }> => {
  const textContent = await page.getTextContent()
  const positioned: PositionedBlock[] = []

  textContent.items.forEach((item, index) => {
    if (!('str' in item) || !item.str.trim()) return
    const transform = item.transform
    const width = Math.max(0.2, (item.width / viewport.width) * 100)
    const height = Math.max(
      0.2,
      (Math.abs(transform[3] ?? item.height) / viewport.height) * 100
    )
    const x = ((transform[4] ?? 0) / viewport.width) * 100
    const baselineY = transform[5] ?? 0
    const y = ((viewport.height - baselineY - (item.height || 0)) / viewport.height) * 100
    positioned.push({
      id: index + 1,
      column: 'single',
      x: Math.max(0, Math.min(100, x)),
      y: Math.max(0, Math.min(100, y)),
      width,
      height,
      text: item.str.trim(),
      centerX: x + width / 2
    })
  })

  classifyColumns(positioned)
  positioned.sort((left, right) => {
    if (left.column !== right.column) {
      if (left.column === 'single') return -1
      if (right.column === 'single') return 1
      return left.column === 'left' ? -1 : 1
    }
    return visualCompare(left, right)
  })

  const blocks = positioned.map(({ centerX: _centerX, ...block }) => block)
  return {
    blocks,
    text: blocks.map((block) => block.text).join(' ').replace(/\s+/g, ' ').trim(),
    textContent
  }
}

export const createStructuredPageContent = (pageNumber: number, blocks: TextBlock[]): string =>
  JSON.stringify({ pageNumber, coordinateUnit: 'percent', layout: 'columns', blocks })

export const createRagChunks = (
  pageNumber: number,
  text: string
): Array<{ id: string; pageNumber: number; text: string }> => {
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (!normalized) return []
  const chunkSize = 1200
  const overlap = 160
  const chunks: Array<{ id: string; pageNumber: number; text: string }> = []
  let start = 0
  let index = 0
  while (start < normalized.length) {
    const end = Math.min(normalized.length, start + chunkSize)
    let chunkText = normalized.slice(start, end)
    if (end < normalized.length) {
      const boundary = Math.max(
        chunkText.lastIndexOf('. '),
        chunkText.lastIndexOf('? '),
        chunkText.lastIndexOf('! ')
      )
      if (boundary > chunkText.length * 0.55) chunkText = chunkText.slice(0, boundary + 1)
    }
    if (chunkText.trim()) {
      chunks.push({ id: `p${pageNumber}-${index}`, pageNumber, text: chunkText.trim() })
      index += 1
    }
    if (end >= normalized.length) break
    start += Math.max(1, chunkText.length - overlap)
  }
  return chunks
}

export const sha256 = async (data: ArrayBuffer): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(digest))
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('')
}
