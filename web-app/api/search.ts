import { parseBody, requirePost, sendError, type WebRequest, type WebResponse } from './_shared'

declare const process: { env: Record<string, string | undefined> }

interface SearchRequest {
  query: unknown
}

interface BingPayload {
  webPages?: { value?: Array<{ name?: string; url?: string; snippet?: string }> }
}

interface TavilyPayload {
  results?: Array<{ title?: string; url?: string; content?: string }>
}

export default async function handler(request: WebRequest, response: WebResponse): Promise<void> {
  try {
    requirePost(request)
    const body = parseBody<SearchRequest>(request)
    const query = typeof body.query === 'string' ? body.query.trim() : ''
    if (!query || query.length > 2000) throw new Error('Search query must be 1 to 2000 characters')
    const provider = (process.env.WEB_SEARCH_PROVIDER || '').trim().toLowerCase()
    const key = process.env.WEB_SEARCH_API_KEY?.trim()
    if (!provider) throw new Error('WEB_SEARCH_PROVIDER is not configured')
    if (!key) throw new Error('WEB_SEARCH_API_KEY is not configured')

    if (provider === 'bing') {
      const upstream = await fetch(
        `https://api.bing.microsoft.com/v7.0/search?q=${encodeURIComponent(query)}&count=5`,
        { headers: { 'Ocp-Apim-Subscription-Key': key } }
      )
      if (!upstream.ok) throw new Error(`Bing search failed (${upstream.status})`)
      const payload = (await upstream.json()) as BingPayload
      response.status(200).json(
        (payload.webPages?.value || [])
          .map((item) => ({ title: item.name || 'Untitled', url: item.url || '', snippet: item.snippet || '' }))
          .filter((item) => item.url)
      )
      return
    }

    if (provider === 'tavily') {
      const upstream = await fetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ api_key: key, query, max_results: 5 })
      })
      if (!upstream.ok) throw new Error(`Tavily search failed (${upstream.status})`)
      const payload = (await upstream.json()) as TavilyPayload
      response.status(200).json(
        (payload.results || [])
          .map((item) => ({ title: item.title || 'Untitled', url: item.url || '', snippet: item.content || '' }))
          .filter((item) => item.url)
      )
      return
    }
    throw new Error('Unsupported WEB_SEARCH_PROVIDER. Use bing or tavily')
  } catch (error) {
    sendError(response, error)
  }
}
