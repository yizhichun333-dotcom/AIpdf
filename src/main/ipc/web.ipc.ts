import { app, ipcMain, session } from 'electron'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export interface WebSearchResult {
  title: string
  url: string
  snippet: string
}

export type WebSearchProvider = 'bing' | 'duckduckgo'

export interface WebSearchConfig {
  provider: WebSearchProvider
  // 为空时使用系统代理；支持 http、https、socks4、socks5。
  proxyAddress: string
}

interface DuckDuckGoInstantAnswer {
  Heading?: string
  AbstractText?: string
  AbstractURL?: string
  RelatedTopics?: Array<{
    Text?: string
    FirstURL?: string
    Topics?: Array<{
      Text?: string
      FirstURL?: string
    }>
  }>
}

const SEARCH_TIMEOUT_MS = 12_000
const MAX_QUERY_LENGTH = 300
const MAX_RESULT_COUNT = 8
const defaultSearchConfig: WebSearchConfig = {
  provider: 'bing',
  proxyAddress: ''
}

const getSearchConfigPath = (): string =>
  join(app.getPath('userData'), 'web-search-config.json')

const normalizeProxyAddress = (value: unknown): string => {
  const proxyAddress = typeof value === 'string' ? value.trim() : ''
  if (!proxyAddress) {
    return ''
  }

  const withScheme = /^[a-z][a-z\d+.-]*:\/\//i.test(proxyAddress)
    ? proxyAddress
    : `http://${proxyAddress}`
  const parsed = new URL(withScheme)
  const supportedProtocols = new Set([
    'http:',
    'https:',
    'socks4:',
    'socks5:'
  ])

  if (!supportedProtocols.has(parsed.protocol) || !parsed.hostname) {
    throw new Error('代理地址必须是 http、https、socks4 或 socks5 地址')
  }
  if (parsed.username || parsed.password) {
    throw new Error('暂不支持带用户名密码的代理地址')
  }

  return parsed.href.replace(/\/$/, '')
}

const normalizeSearchConfig = (
  value: Partial<WebSearchConfig> | undefined
): WebSearchConfig => ({
  provider: value?.provider === 'duckduckgo' ? 'duckduckgo' : 'bing',
  proxyAddress: normalizeProxyAddress(value?.proxyAddress)
})

const readSearchConfig = async (): Promise<WebSearchConfig> => {
  try {
    const saved = JSON.parse(
      await readFile(getSearchConfigPath(), 'utf8')
    ) as Partial<WebSearchConfig>
    return normalizeSearchConfig(saved)
  } catch {
    return defaultSearchConfig
  }
}

const writeSearchConfig = async (
  config: WebSearchConfig
): Promise<void> => {
  await mkdir(app.getPath('userData'), { recursive: true })
  await writeFile(
    getSearchConfigPath(),
    JSON.stringify(config, null, 2),
    'utf8'
  )
}

let searchSession: ReturnType<typeof session.fromPartition> | null = null
let appliedProxyAddress: string | null = null

const getSearchSession = (): ReturnType<typeof session.fromPartition> => {
  searchSession ??= session.fromPartition('ai-pdf-web-search')
  return searchSession
}

const applySearchProxy = async (
  config: WebSearchConfig
): Promise<void> => {
  if (appliedProxyAddress === config.proxyAddress) {
    return
  }

  const currentSession = getSearchSession()
  await currentSession.setProxy(
    config.proxyAddress
      ? {
          mode: 'fixed_servers',
          proxyRules: config.proxyAddress,
          proxyBypassRules: 'localhost,127.0.0.1'
        }
      : { mode: 'system' }
  )
  await currentSession.closeAllConnections()
  appliedProxyAddress = config.proxyAddress
}

const fetchSearch = async (
  url: string,
  init: RequestInit,
  config: WebSearchConfig
): Promise<Response> => {
  await applySearchProxy(config)
  return getSearchSession().fetch(url, init)
}

const decodeHtml = (value: string): string =>
  value
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(
      /&#(\d+);|&#x([\da-f]+);/gi,
      (_match, decimal: string | undefined, hexadecimal: string | undefined) => {
        const codePoint = decimal
          ? Number.parseInt(decimal, 10)
          : Number.parseInt(hexadecimal ?? '', 16)
        return Number.isFinite(codePoint)
          ? String.fromCodePoint(codePoint)
          : ''
      }
    )
    .replace(/\s+/g, ' ')
    .trim()

const resolveSearchUrl = (value: string): string => {
  try {
    const url = new URL(value, 'https://duckduckgo.com')
    const redirectedUrl = url.searchParams.get('uddg')
    const resolved = redirectedUrl ? decodeURIComponent(redirectedUrl) : url.href
    const parsed = new URL(resolved)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
      ? parsed.href
      : ''
  } catch {
    return ''
  }
}

const parseDuckDuckGoHtml = (
  html: string,
  limit: number
): WebSearchResult[] => {
  const resultAnchors = [
    ...html.matchAll(
      /<a\b[^>]*class=["'][^"']*result__a[^"']*["'][^>]*>[\s\S]*?<\/a>/gi
    )
  ]
  const snippets = [
    ...html.matchAll(
      /<a\b[^>]*class=["'][^"']*result__snippet[^"']*["'][^>]*>[\s\S]*?<\/a>/gi
    )
  ].map((match) => decodeHtml(match[0]))

  return resultAnchors
    .map((match, index): WebSearchResult | null => {
      const anchor = match[0]
      const openingTagEnd = anchor.indexOf('>')
      const closingTagStart = anchor.lastIndexOf('</a>')
      if (openingTagEnd < 0 || closingTagStart < 0) {
        return null
      }

      const openingTag = anchor.slice(0, openingTagEnd + 1)
      const hrefMatch = openingTag.match(/\bhref\s*=\s*(["'])(.*?)\1/i)
      const url = hrefMatch?.[2] ? resolveSearchUrl(hrefMatch[2]) : ''
      const title = decodeHtml(
        anchor.slice(openingTagEnd + 1, closingTagStart)
      )
      const snippet = snippets[index] ?? ''

      if (!title || !url) {
        return null
      }

      return {
        title,
        url,
        snippet: snippet || '未提供摘要'
      }
    })
    .filter((result): result is WebSearchResult => result !== null)
    .slice(0, limit)
}

const parseBingHtml = (
  html: string,
  limit: number
): WebSearchResult[] => {
  const resultItems = [
    ...html.matchAll(
      /<li\b[^>]*class=["'][^"']*\bb_algo\b[^"']*["'][^>]*>[\s\S]*?<\/li>/gi
    )
  ]

  return resultItems
    .map((match): WebSearchResult | null => {
      const item = match[0]
      const titleMatch = item.match(
        /<h2\b[^>]*>[\s\S]*?<a\b[^>]*href=["'](.*?)["'][^>]*>([\s\S]*?)<\/a>[\s\S]*?<\/h2>/i
      )
      const snippetMatch = item.match(
        /<p\b[^>]*>([\s\S]*?)<\/p>/i
      )
      const url = titleMatch?.[1]
        ? resolveSearchUrl(titleMatch[1])
        : ''
      const title = decodeHtml(titleMatch?.[2] ?? '')
      const snippet = decodeHtml(snippetMatch?.[1] ?? '')

      if (!title || !url) {
        return null
      }

      return {
        title,
        url,
        snippet: snippet || '未提供摘要'
      }
    })
    .filter((result): result is WebSearchResult => result !== null)
    .slice(0, limit)
}

const parseInstantAnswer = (
  answer: DuckDuckGoInstantAnswer,
  limit: number
): WebSearchResult[] => {
  const results: WebSearchResult[] = []

  if (answer.AbstractText && answer.AbstractURL) {
    results.push({
      title: answer.Heading || 'DuckDuckGo 摘要',
      url: answer.AbstractURL,
      snippet: answer.AbstractText
    })
  }

  const topics = (answer.RelatedTopics ?? []).flatMap((topic) =>
    topic.Topics?.length ? topic.Topics : [topic]
  )
  for (const topic of topics) {
    if (!topic.Text || !topic.FirstURL) {
      continue
    }
    results.push({
      title: topic.Text.slice(0, 120),
      url: topic.FirstURL,
      snippet: topic.Text
    })
    if (results.length >= limit) {
      break
    }
  }

  return results.slice(0, limit)
}

const searchDuckDuckGo = async (
  query: string,
  limit: number,
  config: WebSearchConfig
): Promise<WebSearchResult[]> => {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`
  const response = await fetchSearch(url, {
    headers: {
      Accept: 'text/html,application/xhtml+xml',
      'User-Agent': 'AI-PDF-Reader/1.0'
    },
    signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS)
  }, config)

  if (!response.ok) {
    throw new Error(`联网搜索请求失败：${response.status}`)
  }

  return parseDuckDuckGoHtml(await response.text(), limit)
}

const searchInstantAnswer = async (
  query: string,
  limit: number,
  config: WebSearchConfig
): Promise<WebSearchResult[]> => {
  const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`
  const response = await fetchSearch(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS)
  }, config)

  if (!response.ok) {
    throw new Error(`联网摘要请求失败：${response.status}`)
  }

  return parseInstantAnswer(
    (await response.json()) as DuckDuckGoInstantAnswer,
    limit
  )
}

const searchBing = async (
  query: string,
  limit: number,
  config: WebSearchConfig
): Promise<WebSearchResult[]> => {
  const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}&count=${limit}`
  const response = await fetchSearch(url, {
    headers: {
      Accept: 'text/html,application/xhtml+xml',
      'User-Agent': 'AI-PDF-Reader/1.0'
    },
    signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS)
  }, config)

  if (!response.ok) {
    throw new Error(`Bing 搜索请求失败：${response.status}`)
  }

  return parseBingHtml(await response.text(), limit)
}

const searchDuckDuckGoWithFallback = async (
  query: string,
  limit: number,
  config: WebSearchConfig
): Promise<WebSearchResult[]> => {
  try {
    const results = await searchDuckDuckGo(query, limit, config)
    if (results.length > 0) {
      return results
    }
  } catch (error) {
    console.warn('[web] DuckDuckGo HTML search failed, trying instant answer', error)
  }

  return searchInstantAnswer(query, limit, config)
}

export function registerWebIpc(): void {
  ipcMain.handle(
    'web:get-config',
    async (): Promise<WebSearchConfig> => readSearchConfig()
  )

  ipcMain.handle(
    'web:set-config',
    async (
      _event,
      request: Partial<WebSearchConfig>
    ): Promise<WebSearchConfig> => {
      const config = normalizeSearchConfig(request)
      await applySearchProxy(config)
      await writeSearchConfig(config)
      return config
    }
  )

  ipcMain.handle(
    'web:search',
    async (
      _event,
      request: { query: string; limit?: number }
    ): Promise<WebSearchResult[]> => {
      const query = request?.query?.trim()
      if (!query) {
        throw new Error('请输入联网搜索问题')
      }
      if (query.length > MAX_QUERY_LENGTH) {
        throw new Error(`搜索问题不能超过 ${MAX_QUERY_LENGTH} 个字符`)
      }

      const limit = Math.max(
        1,
        Math.min(request.limit ?? 5, MAX_RESULT_COUNT)
      )
      const config = await readSearchConfig()
      console.log(
        `[web] provider=${config.provider}, proxy=${config.proxyAddress ? 'custom' : 'system'}, queryLength=${query.length}, limit=${limit}`
      )

      const errors: string[] = []
      const primarySearch =
        config.provider === 'bing' ? searchBing : searchDuckDuckGoWithFallback
      const fallbackSearch =
        config.provider === 'bing' ? searchDuckDuckGoWithFallback : searchBing

      try {
        const results = await primarySearch(query, limit, config)
        if (results.length > 0) {
          return results
        }
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error))
        console.warn('[web] primary search failed, trying fallback', error)
      }

      try {
        return await fallbackSearch(query, limit, config)
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error))
        throw new Error(`联网搜索失败：${errors.join('；')}`)
      }
    }
  )
}
