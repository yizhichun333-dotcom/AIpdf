# AIpdf Web

This is the browser version of AIpdf. It is intentionally separate from the Electron app.
PDF files, annotations, conversations, and RAG indexes stay in the current browser's IndexedDB.
The browser sends text or selected images to the Vercel API functions; provider credentials stay
in Vercel environment variables.

## Local development

```powershell
cd D:\Desktop\ai_pdf\web-app
npm install
npm run dev
```

## Required Vercel variables

Set `AI_API_BASE_URL` to an OpenAI-compatible API base URL, and set `AI_API_KEY` in Vercel.
`AI_DEFAULT_MODEL` is the fallback. A role-specific value overrides it:

- `AI_TRANSLATION_MODEL`
- `AI_CHAT_MODEL`
- `AI_VISION_MODEL`
- `AI_EMBEDDING_MODEL`

Optional web search uses `WEB_SEARCH_PROVIDER=bing` or `WEB_SEARCH_PROVIDER=tavily` together
with `WEB_SEARCH_API_KEY`. If a role-specific model or search provider is not configured,
that feature reports a clear error in the page.

## Vercel project settings

- Root Directory: `web-app`
- Build Command: `npm run build`
- Output Directory: `dist`

The Vercel project automatically exposes `api/chat`, `api/translate`, `api/vision`,
`api/embed`, and `api/search` as server functions.

## Limits

- PDF: 50 MB
- Image payload: 12 MB
- Text request: 10,000 characters

The web version does not run Ollama and does not upload the complete PDF file. It extracts
text in the browser and sends only the relevant text, embedding requests, or image selection.
