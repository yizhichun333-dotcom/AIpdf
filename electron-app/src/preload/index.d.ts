// 导入 @electron‑toolkit/preload 提供的 ElectronAPI 类型定义
import { ElectronAPI } from '@electron-toolkit/preload'

// 声明全局 Window 接口，扩展浏览器 window 对象的类型，给TypeScript做类型提示
declare global {
  interface Window {
    // window.electron：来自@electron‑toolkit的内置electron API，类型为ElectronAPI
    electron: ElectronAPI

    // window.desktop：我们自定义的业务API对象
    desktop: {
      // openPdf 方法：返回Promise，异步调用打开PDF对话框
      openPdf: () => Promise<{
        // 选中PDF文件的本地绝对路径
        filePath: string
        // PDF文件名（不含路径，例如 test.pdf）
        fileName: string
        // PDF二进制原始数据 Uint8Array，给pdfjs‑dist渲染使用
        data: Uint8Array
      } | null> // 用户取消选择时返回 null

      ai: {
        getConfig: () => Promise<{
          backend: 'ollama' | 'api'
          apiBaseUrl: string
          apiKeySet: boolean
          apiModels: {
            translation: string
            chat: string
            vision: string
            embedding: string
          }
        }>
        saveConfig: (request: {
          backend: 'ollama' | 'api'
          apiBaseUrl: string
          apiKey?: string
          clearApiKey?: boolean
          apiModels: {
            translation: string
            chat: string
            vision: string
            embedding: string
          }
        }) => Promise<{
          backend: 'ollama' | 'api'
          apiBaseUrl: string
          apiKeySet: boolean
          apiModels: {
            translation: string
            chat: string
            vision: string
            embedding: string
          }
        }>
      }

      translator: {
        translate: (request: {
          text: string
          targetLanguage: 'zh' | 'en'
          action: 'translate' | 'explain' | 'rag' | 'selection-rag'
          prompt?: string
          webSearchEnabled?: boolean
        }) => Promise<{ content: string; thinking?: string }>
      }
      web: {
        getConfig: () => Promise<{
          provider: 'bing' | 'duckduckgo'
          proxyAddress: string
        }>
        setConfig: (request: {
          provider: 'bing' | 'duckduckgo'
          proxyAddress: string
        }) => Promise<{
          provider: 'bing' | 'duckduckgo'
          proxyAddress: string
        }>
        search: (request: {
          query: string
          limit?: number
        }) => Promise<Array<{
          title: string
          url: string
          snippet: string
        }>>
      }
      rag: {
        indexDocument: (request: {
          filePath: string
          chunks: Array<{ id: string; pageNumber: number; text: string }>
        }) => Promise<{ cached: boolean; chunkCount: number }>
        search: (request: {
          filePath: string
          query: string
          limit?: number
        }) => Promise<Array<{
          pageNumber: number
          text: string
          score: number
        }>>
      }
      vision: {
        analyze: (request: {
          imageBase64: string
          pageNumber: number
          question: string
        }) => Promise<{ content: string }>
      }
      models: {
        getState: () => Promise<{
          candidates: Array<{
            id: string
            label: string
            description: string
            size: string
            role: 'translation' | 'chat' | 'vision'
          }>
          installedModelIds: string[]
          preferences: {
            translation: string
            chat: string
            vision: string
          }
        }>
        select: (request: {
          role: 'translation' | 'chat' | 'vision'
          modelId: string
        }) => Promise<unknown>
        download: (request: { modelId: string }) => Promise<unknown>
        downloadAndSelect: (request: {
          role: 'translation' | 'chat' | 'vision'
          modelId: string
        }) => Promise<unknown>
      }
    }
  }
}

// 导出空对象，让ts把该文件识别为模块，避免全局声明报错
export {}
