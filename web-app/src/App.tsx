import {
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useRef,
  useState
} from 'react'
import { analyzeVision, chat, embed, searchWeb, translate, type ChatReply } from './lib/api'
import {
  clearWebStorage,
  getAnnotations,
  getConversation,
  getDocument,
  getRagIndex,
  listDocuments,
  saveAnnotation,
  saveConversation,
  saveDocument,
  saveRagIndex
} from './lib/db'
import {
  createRagChunks,
  getPageBlocks,
  loadPdf,
  renderTextLayer,
  sha256,
  type PdfDocument
} from './lib/pdf'
import type {
  Annotation,
  ChatAction,
  ChatMessage,
  ImageSelection,
  RagChunk,
  RagIndex,
  StoredDocument,
  TextBlock,
  WebSearchResult
} from './lib/types'

const MAX_PDF_SIZE = 50 * 1024 * 1024
const MAX_TEXT_LENGTH = 10_000
const MAX_RAG_MATCHES = 5

type ChatScope = 'page' | 'document'
type SelectionMenu = { left: number; top: number }

const errorMessage = (value: unknown): string =>
  value instanceof Error ? value.message : 'The operation failed. Please try again.'

const makeId = (prefix: string): string =>
  `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

const truncate = (value: string, limit = MAX_TEXT_LENGTH): string => {
  const text = value.trim()
  if (text.length <= limit) return text
  const boundary = Math.max(text.lastIndexOf('. ', limit), text.lastIndexOf(' ', limit))
  return text.slice(0, boundary > limit * 0.6 ? boundary : limit).trim()
}

const cosine = (left: number[], right: number[]): number => {
  let dot = 0
  let leftLength = 0
  let rightLength = 0
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    const a = left[index] || 0
    const b = right[index] || 0
    dot += a * b
    leftLength += a * a
    rightLength += b * b
  }
  return leftLength && rightLength ? dot / Math.sqrt(leftLength * rightLength) : 0
}

const orderedColumnText = (blocks: TextBlock[]): string => {
  const left = blocks.filter((block) => block.column === 'left')
  const right = blocks.filter((block) => block.column === 'right')
  if (left.length >= 3 && right.length >= 3) {
    return [
      'LEFT COLUMN',
      left.map((block) => block.text).join(' '),
      'RIGHT COLUMN',
      right.map((block) => block.text).join(' ')
    ].join('\n')
  }
  return blocks.map((block) => block.text).join(' ').replace(/\s+/g, ' ').trim()
}

const markTextAnnotations = (
  layer: HTMLDivElement,
  pageNumber: number,
  annotations: Annotation[]
): void => {
  layer.querySelectorAll('[data-aipdf-annotation]').forEach((node) =>
    node.removeAttribute('data-aipdf-annotation')
  )
  const texts = annotations
    .filter((item) => item.pageNumber === pageNumber && item.kind === 'text' && item.selectedText)
    .map((item) => item.selectedText!.trim())
    .filter(Boolean)
  if (!texts.length) return
  layer.querySelectorAll('span').forEach((span) => {
    const value = span.textContent?.trim() || ''
    if (value && texts.some((text) => text.includes(value) || value.includes(text))) {
      span.setAttribute('data-aipdf-annotation', 'true')
    }
  })
}

const imageStyle = (selection: ImageSelection): CSSProperties => ({
  left: `${selection.left * 100}%`,
  top: `${selection.top * 100}%`,
  width: `${selection.width * 100}%`,
  height: `${selection.height * 100}%`
})

function App(): React.JSX.Element {
  const [documents, setDocuments] = useState<StoredDocument[]>([])
  const [pdfRecord, setPdfRecord] = useState<StoredDocument | null>(null)
  const [pdf, setPdf] = useState<PdfDocument | null>(null)
  const pdfRef = useRef<PdfDocument | null>(null)
  const [totalPages, setTotalPages] = useState(0)
  const [currentPage, setCurrentPage] = useState(1)
  const [scale, setScale] = useState(1)
  const [isRendering, setIsRendering] = useState(false)
  const renderToken = useRef(0)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const textLayerRef = useRef<HTMLDivElement>(null)
  const [pageText, setPageText] = useState('')
  const [pageBlocks, setPageBlocks] = useState<TextBlock[]>([])
  const [status, setStatus] = useState('Choose a PDF file to begin')
  const [error, setError] = useState('')

  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [chatInput, setChatInput] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [aiError, setAiError] = useState('')
  const [chatScope, setChatScope] = useState<ChatScope>('document')
  const [selectedText, setSelectedText] = useState('')
  const [discussionText, setDiscussionText] = useState('')
  const [selectionMenu, setSelectionMenu] = useState<SelectionMenu | null>(null)
  const [annotations, setAnnotations] = useState<Annotation[]>([])
  const [visionMode, setVisionMode] = useState(false)
  const [imageSelection, setImageSelection] = useState<ImageSelection | null>(null)
  const imageStart = useRef<{ x: number; y: number } | null>(null)
  const [webEnabled, setWebEnabled] = useState(false)
  const [ragReady, setRagReady] = useState(false)
  const [ragStatus, setRagStatus] = useState('')
  const ragToken = useRef(0)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const imageAnnotations = annotations.filter(
    (item) => item.pageNumber === currentPage && item.kind === 'image' && item.imageSelection
  )

  const renderPage = async (
    documentProxy: PdfDocument,
    pageNumber: number,
    nextScale: number
  ): Promise<void> => {
    const canvas = canvasRef.current
    const layer = textLayerRef.current
    if (!canvas || !layer) return
    const token = renderToken.current + 1
    renderToken.current = token
    setIsRendering(true)
    setError('')
    try {
      const page = await documentProxy.getPage(pageNumber)
      const viewport = page.getViewport({ scale: nextScale })
      const outputScale = window.devicePixelRatio || 1
      canvas.width = Math.floor(viewport.width * outputScale)
      canvas.height = Math.floor(viewport.height * outputScale)
      canvas.style.width = `${Math.floor(viewport.width)}px`
      canvas.style.height = `${Math.floor(viewport.height)}px`
      layer.style.width = `${Math.floor(viewport.width)}px`
      layer.style.height = `${Math.floor(viewport.height)}px`
      const context = canvas.getContext('2d')
      if (!context) throw new Error('Could not create a PDF canvas')
      await page.render({
        canvas,
        viewport,
        transform: outputScale === 1 ? undefined : [outputScale, 0, 0, outputScale, 0, 0]
      }).promise
      const content = await getPageBlocks(page, viewport)
      if (token !== renderToken.current) return
      await renderTextLayer(content.textContent, layer, viewport)
      markTextAnnotations(layer, pageNumber, annotations)
      if (token !== renderToken.current) return
      setCurrentPage(pageNumber)
      setScale(nextScale)
      setPageBlocks(content.blocks)
      setPageText(content.text)
      setSelectedText('')
      setDiscussionText('')
      setSelectionMenu(null)
      setImageSelection(null)
      setStatus(`Page ${pageNumber} / ${documentProxy.numPages} - ${Math.round(nextScale * 100)}%`)
    } catch (renderError) {
      if (token === renderToken.current) setError(`Page render failed: ${errorMessage(renderError)}`)
    } finally {
      if (token === renderToken.current) setIsRendering(false)
    }
  }

  useEffect(() => {
    if (textLayerRef.current) markTextAnnotations(textLayerRef.current, currentPage, annotations)
  }, [annotations, currentPage])

  useEffect(() => {
    const handleSelection = (): void => {
      const selection = window.getSelection()
      const layer = textLayerRef.current
      if (!selection || !layer || !selection.rangeCount || !selection.toString().trim()) return
      if (!layer.contains(selection.anchorNode)) return
      const rect = selection.getRangeAt(0).getBoundingClientRect()
      setSelectedText(selection.toString().trim())
      setSelectionMenu({
        left: Math.min(window.innerWidth - 330, Math.max(8, rect.left)),
        top: Math.max(8, rect.top - 44)
      })
    }
    document.addEventListener('selectionchange', handleSelection)
    return () => document.removeEventListener('selectionchange', handleSelection)
  }, [])

  const buildRagIndex = async (
    documentProxy: PdfDocument,
    fileHash: string,
    force = false
  ): Promise<void> => {
    const token = ragToken.current + 1
    ragToken.current = token
    setRagReady(false)
    setRagStatus('Reading PDF pages...')
    try {
      if (!force) {
        const cached = await getRagIndex(fileHash)
        if (cached?.chunks.length && cached.embeddings.length === cached.chunks.length) {
          setRagReady(true)
          setRagStatus(`RAG ready: ${cached.chunks.length} chunks`)
          return
        }
      }
      const chunks: RagChunk[] = []
      for (let pageNumber = 1; pageNumber <= documentProxy.numPages; pageNumber += 1) {
        const page = await documentProxy.getPage(pageNumber)
        const viewport = page.getViewport({ scale: 1 })
        const content = await getPageBlocks(page, viewport)
        chunks.push(...createRagChunks(pageNumber, orderedColumnText(content.blocks)))
        setRagStatus(`Reading page ${pageNumber} / ${documentProxy.numPages}...`)
        if (token !== ragToken.current) return
      }
      if (!chunks.length) {
        setRagStatus('No text layer found. Scanned PDFs need OCR.')
        return
      }
      const embeddings: number[][] = []
      let embeddingModel = ''
      for (let start = 0; start < chunks.length; start += 16) {
        const batch = chunks.slice(start, start + 16)
        const result = await embed(batch.map((chunk) => chunk.text))
        embeddingModel = result.model
        embeddings.push(...result.embeddings)
        setRagStatus(`Embedding ${Math.min(start + batch.length, chunks.length)} / ${chunks.length}...`)
        if (token !== ragToken.current) return
      }
      const index: RagIndex = {
        id: `${fileHash}:${embeddingModel}`,
        fileHash,
        embeddingModel,
        chunks,
        embeddings,
        updatedAt: Date.now()
      }
      await saveRagIndex(index)
      if (token !== ragToken.current) return
      setRagReady(true)
      setRagStatus(`RAG ready: ${chunks.length} chunks`)
    } catch (ragError) {
      if (token === ragToken.current) setRagStatus(`RAG build failed: ${errorMessage(ragError)}`)
    }
  }

  const loadDocumentState = async (record: StoredDocument, loaded: PdfDocument): Promise<void> => {
    const [savedMessages, savedAnnotations] = await Promise.all([
      getConversation(record.fileHash),
      getAnnotations(record.fileHash)
    ])
    pdfRef.current = loaded
    setPdf(loaded)
    setPdfRecord(record)
    setDocuments((current) => [record, ...current.filter((item) => item.fileHash !== record.fileHash)])
    setTotalPages(loaded.numPages)
    setMessages(savedMessages)
    setAnnotations(savedAnnotations)
    setCurrentPage(1)
    setRagReady(false)
    setRagStatus('')
    await renderPage(loaded, 1, 1)
    void buildRagIndex(loaded, record.fileHash)
  }

  const openPdfFile = async (file: File): Promise<void> => {
    if (file.size > MAX_PDF_SIZE) {
      setError('PDF files must be 50 MB or smaller')
      return
    }
    if (file.type && file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
      setError('Please choose a PDF file')
      return
    }
    setError('')
    setStatus('Opening PDF...')
    try {
      const data = await file.arrayBuffer()
      const fileHash = await sha256(data)
      const loaded = await loadPdf(data.slice(0))
      const record: StoredDocument = {
        fileHash,
        fileName: file.name,
        pageCount: loaded.numPages,
        data: data.slice(0),
        updatedAt: Date.now()
      }
      await saveDocument(record)
      localStorage.setItem('aipdf-last-file-hash', fileHash)
      await loadDocumentState(record, loaded)
    } catch (openError) {
      setError(`PDF open failed: ${errorMessage(openError)}`)
      setStatus('PDF open failed')
    }
  }

  const reopenSavedPdf = async (record: StoredDocument): Promise<void> => {
    try {
      const loaded = await loadPdf(record.data.slice(0))
      await loadDocumentState(record, loaded)
    } catch (openError) {
      setError(`Saved PDF could not be opened: ${errorMessage(openError)}`)
    }
  }

  useEffect(() => {
    const loadLastDocument = async (): Promise<void> => {
      setDocuments(await listDocuments())
      const lastHash = localStorage.getItem('aipdf-last-file-hash')
      if (!lastHash) return
      const record = await getDocument(lastHash)
      if (record) await reopenSavedPdf(record)
    }
    void loadLastDocument().catch((loadError) => setError(errorMessage(loadError)))
  }, [])

  const goToPage = async (pageNumber: number): Promise<void> => {
    if (!pdfRef.current || isRendering || pageNumber < 1 || pageNumber > totalPages) return
    await renderPage(pdfRef.current, pageNumber, scale)
  }

  const getImagePoint = (event: ReactPointerEvent<HTMLDivElement>): { x: number; y: number } => {
    const rect = event.currentTarget.getBoundingClientRect()
    return {
      x: Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)),
      y: Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height))
    }
  }

  const handleImagePointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (!visionMode) return
    event.currentTarget.setPointerCapture(event.pointerId)
    imageStart.current = getImagePoint(event)
    setImageSelection(null)
  }

  const handleImagePointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const start = imageStart.current
    if (!start) return
    const point = getImagePoint(event)
    setImageSelection({
      left: Math.min(start.x, point.x),
      top: Math.min(start.y, point.y),
      width: Math.abs(point.x - start.x),
      height: Math.abs(point.y - start.y)
    })
  }

  const handleImagePointerUp = (): void => {
    imageStart.current = null
  }

  const getImageBase64 = (): string => {
    const canvas = canvasRef.current
    if (!canvas) return ''
    const selection = imageSelection
    const sourceX = selection ? Math.round(selection.left * canvas.width) : 0
    const sourceY = selection ? Math.round(selection.top * canvas.height) : 0
    const sourceWidth = selection ? Math.max(1, Math.round(selection.width * canvas.width)) : canvas.width
    const sourceHeight = selection ? Math.max(1, Math.round(selection.height * canvas.height)) : canvas.height
    const output = document.createElement('canvas')
    const ratio = Math.min(1, 1800 / Math.max(sourceWidth, sourceHeight))
    output.width = Math.max(1, Math.round(sourceWidth * ratio))
    output.height = Math.max(1, Math.round(sourceHeight * ratio))
    const context = output.getContext('2d')
    if (!context) return ''
    context.drawImage(canvas, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, output.width, output.height)
    return output.toDataURL('image/jpeg', 0.9).split(',', 2)[1] || ''
  }

  const searchRag = async (query: string): Promise<Array<{ pageNumber: number; text: string }>> => {
    if (!pdfRecord) return []
    const index = await getRagIndex(pdfRecord.fileHash)
    if (!index) return []
    const queryResult = await embed(query)
    if (queryResult.model !== index.embeddingModel && pdfRef.current) {
      await buildRagIndex(pdfRef.current, pdfRecord.fileHash, true)
      const rebuilt = await getRagIndex(pdfRecord.fileHash)
      if (!rebuilt) return []
      const retry = await embed(query)
      return rebuilt.chunks
        .map((chunk, indexValue) => ({
          pageNumber: chunk.pageNumber,
          text: chunk.text,
          score: cosine(retry.embeddings[0] || [], rebuilt.embeddings[indexValue] || [])
        }))
        .sort((left, right) => right.score - left.score)
        .slice(0, MAX_RAG_MATCHES)
    }
    return index.chunks
      .map((chunk, indexValue) => ({
        pageNumber: chunk.pageNumber,
        text: chunk.text,
        score: cosine(queryResult.embeddings[0] || [], index.embeddings[indexValue] || [])
      }))
      .sort((left, right) => right.score - left.score)
      .slice(0, MAX_RAG_MATCHES)
  }

  const saveMessages = async (nextMessages: ChatMessage[]): Promise<void> => {
    setMessages(nextMessages)
    if (pdfRecord) await saveConversation(pdfRecord.fileHash, nextMessages)
  }

  const appendReply = async (
    userMessage: ChatMessage,
    reply: ChatReply,
    webSources: WebSearchResult[] = []
  ): Promise<void> => {
    const assistant: ChatMessage = {
      id: makeId('assistant'),
      role: 'assistant',
      content: reply.content,
      thinking: reply.thinking,
      action: userMessage.action,
      createdAt: Date.now(),
      pageNumber: currentPage,
      webSources: webSources.length ? webSources : undefined
    }
    await saveMessages([...messages, userMessage, assistant])
  }

  const sendMessage = async (presetQuestion?: string): Promise<void> => {
    const question = (presetQuestion ?? chatInput).trim()
    if (!question || !pdfRecord || isLoading || isRendering) return
    setChatInput('')
    setAiError('')
    setIsLoading(true)
    const action: ChatAction = visionMode ? 'vision' : 'chat'
    const userMessage: ChatMessage = {
      id: makeId('user'),
      role: 'user',
      content: question,
      action,
      createdAt: Date.now(),
      pageNumber: currentPage,
      sourceText: discussionText || undefined
    }
    try {
      if (visionMode) {
        const imageBase64 = getImageBase64()
        if (!imageBase64) throw new Error('The current PDF page image is empty')
        await appendReply(userMessage, await analyzeVision({ imageBase64, pageNumber: currentPage, question }))
        return
      }

      let webSources: WebSearchResult[] = []
      let webContext = ''
      if (webEnabled) {
        try {
          webSources = await searchWeb(question)
          webContext = webSources.map((source, index) => `WEB SOURCE ${index + 1}: ${source.title}\n${source.snippet}`).join('\n')
        } catch (webError) {
          setAiError(`Web search failed: ${errorMessage(webError)}. Continuing with PDF context.`)
        }
      }

      let context = ''
      let apiAction: 'chat' | 'rag' | 'selection-rag' = 'chat'
      if (discussionText) {
        apiAction = 'selection-rag'
        const matches = ragReady ? await searchRag(question) : []
        context = [
          `SELECTED PDF TEXT (page ${currentPage})`,
          truncate(discussionText),
          'END SELECTED PDF TEXT',
          ...matches.map((match, index) => `RETRIEVED PDF SNIPPET ${index + 1} (page ${match.pageNumber})\n${truncate(match.text, 1800)}`)
        ].join('\n')
      } else if (chatScope === 'document') {
        if (!ragReady) throw new Error('Full-document RAG is still building. Please wait.')
        const matches = await searchRag(question)
        if (!matches.length) throw new Error('No related PDF snippets were found. Check the embedding service.')
        apiAction = 'rag'
        context = matches.map((match, index) => `RETRIEVED PDF SNIPPET ${index + 1} (page ${match.pageNumber})\n${truncate(match.text, 1800)}`).join('\n')
      } else {
        context = `CURRENT PDF PAGE ${currentPage}\n${orderedColumnText(pageBlocks)}`
      }

      const history = messages
        .filter((message) => message.pageNumber === currentPage)
        .slice(-8)
        .map((message) => ({ role: message.role, content: message.content }))
      const promptContext = truncate(context, 8000)
      const prompt = [
        promptContext,
        webContext ? `WEB SEARCH CONTEXT\n${truncate(webContext, 1600)}` : '',
        'USER QUESTION',
        truncate(question, 1800)
      ].filter(Boolean).join('\n')
      const reply = await chat({
        messages: [...history, { role: 'user', content: truncate(prompt) }],
        action: apiAction,
        webSearchEnabled: webSources.length > 0
      })
      await appendReply(userMessage, reply, webSources)
    } catch (sendError) {
      setAiError(errorMessage(sendError))
    } finally {
      setIsLoading(false)
    }
  }

  const runSelectedAction = async (action: 'translate' | 'explain'): Promise<void> => {
    const source = selectedText.trim()
    if (!source || !pdfRecord || isLoading) return
    setIsLoading(true)
    setAiError('')
    const userMessage: ChatMessage = {
      id: makeId('user'),
      role: 'user',
      content: action === 'translate' ? 'Translate selected text' : 'Explain selected text',
      action,
      createdAt: Date.now(),
      pageNumber: currentPage,
      sourceText: source
    }
    try {
      const reply = action === 'translate'
        ? await translate({ text: truncate(source), targetLanguage: 'zh', prompt: 'Output only the complete translation.' })
        : await chat({
            action: 'chat',
            messages: [{ role: 'user', content: `Translate and explain this selected PDF text. Include vocabulary, concepts, and paragraph logic.\n${truncate(source)}` }]
          })
      await appendReply(userMessage, reply)
      setSelectionMenu(null)
    } catch (actionError) {
      setAiError(errorMessage(actionError))
    } finally {
      setIsLoading(false)
    }
  }

  const runFullPageTranslation = async (): Promise<void> => {
    if (!pdfRecord || !pageText || isLoading) return
    setIsLoading(true)
    setAiError('')
    const userMessage: ChatMessage = {
      id: makeId('user'),
      role: 'user',
      content: 'Translate current page',
      action: 'translate',
      createdAt: Date.now(),
      pageNumber: currentPage
    }
    try {
      const reply = await translate({
        text: truncate(orderedColumnText(pageBlocks)),
        targetLanguage: 'zh',
        prompt: 'Translate the complete page. Keep LEFT COLUMN before RIGHT COLUMN and output only the translation.'
      })
      await appendReply(userMessage, reply)
    } catch (translationError) {
      setAiError(errorMessage(translationError))
    } finally {
      setIsLoading(false)
    }
  }

  const addTextAnnotation = async (): Promise<void> => {
    const source = selectedText.trim()
    if (!source || !pdfRecord) return
    const comment = window.prompt('Comment for this text')?.trim()
    if (!comment) return
    const annotation: Annotation = {
      id: makeId('annotation'),
      fileHash: pdfRecord.fileHash,
      pageNumber: currentPage,
      kind: 'text',
      selectedText: source,
      comment,
      createdAt: Date.now()
    }
    await saveAnnotation(annotation)
    setAnnotations((current) => [...current, annotation])
    setSelectionMenu(null)
  }

  const addImageAnnotation = async (): Promise<void> => {
    if (!imageSelection || !pdfRecord) return
    const comment = window.prompt('Comment for this image area')?.trim()
    if (!comment) return
    const annotation: Annotation = {
      id: makeId('annotation'),
      fileHash: pdfRecord.fileHash,
      pageNumber: currentPage,
      kind: 'image',
      imageSelection,
      comment,
      createdAt: Date.now()
    }
    await saveAnnotation(annotation)
    setAnnotations((current) => [...current, annotation])
  }

  const clearStorage = async (): Promise<void> => {
    if (!window.confirm('Clear saved PDFs, annotations, chats, and RAG indexes from this browser?')) return
    await clearWebStorage()
    localStorage.removeItem('aipdf-last-file-hash')
    window.location.reload()
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <h1>AIpdf Web</h1>
          <span className="muted">Browser PDF reading, translation, and AI questions</span>
        </div>
        <div className="top-actions">
          <button onClick={() => fileInputRef.current?.click()}>Open PDF</button>
          <input ref={fileInputRef} type="file" accept="application/pdf,.pdf" hidden onChange={(event) => {
            const file = event.target.files?.[0]
            if (file) void openPdfFile(file)
            event.target.value = ''
          }} />
          <button className="secondary" onClick={() => void clearStorage()}>Clear browser data</button>
        </div>
      </header>

      <section className="workspace">
        <aside className="panel left-panel">
          <h2>Documents</h2>
          {!pdfRecord ? <p className="empty">Choose a PDF to start reading.</p> : <>
            <div className="file-card"><strong title={pdfRecord.fileName}>{pdfRecord.fileName}</strong><span>{pdfRecord.pageCount} pages - saved locally</span></div>
            {documents.length > 1 && <section className="document-list"><h3>Recent PDFs</h3>{documents.map((document) => <button key={document.fileHash} className={document.fileHash === pdfRecord.fileHash ? 'document-button active' : 'document-button'} onClick={() => void reopenSavedPdf(document)} disabled={isLoading || isRendering} title={document.fileName}>{document.fileName}</button>)}</section>}
            <div className="info-card"><strong>Current page</strong><span>Page {currentPage} - {pageText.length} characters</span>{!pageText && <span className="warning">No text layer. This page may need OCR.</span>}</div>
            <div className="info-card"><strong>Full-document RAG</strong><span>{ragStatus || 'Not started'}</span></div>
            <section className="annotation-list"><h3>Annotations ({annotations.length})</h3>{annotations.length === 0 ? <p className="muted">Select text or an image to add a comment.</p> : annotations.map((annotation) => <article key={annotation.id} className="annotation-item"><span>Page {annotation.pageNumber} - {annotation.kind}</span><p>{annotation.comment}</p></article>)}</section>
          </>}
        </aside>

        <section className="panel reader-panel">
          <div className="reader-toolbar">
            <button disabled={!pdf || isRendering || currentPage <= 1} onClick={() => void goToPage(currentPage - 1)}>Previous</button>
            <span>{pdf ? `Page ${currentPage} / ${totalPages}` : 'No PDF'}</span>
            <button disabled={!pdf || isRendering || currentPage >= totalPages} onClick={() => void goToPage(currentPage + 1)}>Next</button>
            <span className="toolbar-separator" />
            <button disabled={!pdf || isRendering || scale <= 0.5} onClick={() => pdfRef.current && void renderPage(pdfRef.current, currentPage, Math.max(0.5, scale - 0.1))}>-</button>
            <button disabled={!pdf || isRendering} onClick={() => pdfRef.current && void renderPage(pdfRef.current, currentPage, 1)}>{Math.round(scale * 100)}%</button>
            <button disabled={!pdf || isRendering || scale >= 2.5} onClick={() => pdfRef.current && void renderPage(pdfRef.current, currentPage, Math.min(2.5, scale + 0.1))}>+</button>
            <span className="reader-status">{isRendering ? 'Rendering...' : status}</span>
          </div>
          {error && <div className="error-banner">{error}</div>}
          <div className="reader-scroll">
            <div className={`page-surface ${visionMode ? 'vision-active' : ''}`} style={{ display: pdf ? 'inline-block' : 'none' }}>
              <canvas ref={canvasRef} />
              <div ref={textLayerRef} className="textLayer" />
              {(visionMode || imageAnnotations.length > 0) && <div className="image-selection-layer" onPointerDown={handleImagePointerDown} onPointerMove={handleImagePointerMove} onPointerUp={handleImagePointerUp}>
                {imageSelection && <div className="image-selection-box" style={imageStyle(imageSelection)} />}
                {imageAnnotations.map((annotation) => <div key={annotation.id} className="saved-image-marker" style={imageStyle(annotation.imageSelection!)} />)}
              </div>}
            </div>
            {!pdf && <div className="reader-empty">Open a PDF from the top bar.</div>}
          </div>
          {selectionMenu && selectedText && <div className="selection-menu" style={{ left: selectionMenu.left, top: selectionMenu.top }}>
            <button onClick={() => void runSelectedAction('translate')}>Translate</button>
            <button onClick={() => void runSelectedAction('explain')}>Explain</button>
            <button onClick={() => { setDiscussionText(selectedText); setSelectionMenu(null) }}>Xiaoyi chat</button>
            <button onClick={() => void addTextAnnotation()}>Comment</button>
          </div>}
        </section>

        <aside className="panel chat-panel">
          <div className="chat-header"><div><h2>AI Chat</h2><span className="muted">API keys stay on the Vercel server</span></div><button className="secondary small" onClick={() => void saveMessages([])} disabled={!pdfRecord || isLoading}>Clear chat</button></div>
          <div className="chat-options">
            <label>Scope<select value={chatScope} onChange={(event) => setChatScope(event.target.value as ChatScope)} disabled={visionMode}><option value="document">Full document (RAG)</option><option value="page">Current page</option></select></label>
            <label className="check-label"><input type="checkbox" checked={webEnabled} onChange={(event) => setWebEnabled(event.target.checked)} disabled={visionMode} /> Web search</label>
            <label className="check-label"><input type="checkbox" checked={visionMode} onChange={(event) => { setVisionMode(event.target.checked); setImageSelection(null) }} disabled={!pdfRecord || isLoading} /> Image understanding</label>
          </div>
          {visionMode && <div className="hint">Drag a rectangle on the PDF image. Without a rectangle, the whole page is sent. {imageSelection && <button className="link-button" onClick={() => void addImageAnnotation()}>Comment selected image</button>}</div>}
          {discussionText && <div className="discussion-card"><strong>Fixed selection for chat</strong><p>{discussionText.length > 400 ? `${discussionText.slice(0, 400)}...` : discussionText}</p><button className="link-button" onClick={() => setDiscussionText('')}>Clear selection</button></div>}
          <div className="messages" aria-live="polite">
            {messages.length === 0 && <div className="empty">Open a PDF, then ask a question or select text.</div>}
            {messages.map((message) => <article key={message.id} className={`message ${message.role}`}><div className="message-meta">{message.role === 'user' ? 'You' : 'AI'} - page {message.pageNumber || '-'}</div>{message.sourceText && <details className="source-text"><summary>Show source text</summary><p>{message.sourceText}</p></details>}<div className="message-content">{message.content}</div>{message.thinking && <details className="thinking"><summary>Show thinking record</summary><p>{message.thinking}</p></details>}{message.webSources && message.webSources.length > 0 && <details className="web-sources"><summary>Web sources ({message.webSources.length})</summary>{message.webSources.map((source) => <a key={source.url} href={source.url} target="_blank" rel="noreferrer">{source.title}</a>)}</details>}</article>)}
            {isLoading && <div className="loading">AI is answering...</div>}
          </div>
          {aiError && <div className="error-banner">{aiError}</div>}
          {pdfRecord && !visionMode && pageText && <button className="full-translation" onClick={() => void runFullPageTranslation()} disabled={isLoading || isRendering}>Translate current page</button>}
          <div className="composer"><textarea value={chatInput} onChange={(event) => setChatInput(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void sendMessage() } }} placeholder={visionMode ? 'Ask about this image...' : 'Ask about the PDF...'} rows={3} disabled={!pdfRecord || isLoading} /><button onClick={() => void sendMessage()} disabled={!pdfRecord || !chatInput.trim() || isLoading || isRendering || (!visionMode && chatScope === 'document' && !ragReady && !discussionText)}>Send</button></div>
        </aside>
      </section>
    </main>
  )
}

export default App
