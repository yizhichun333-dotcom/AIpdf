// 从electron模块导入contextBridge、ipcRenderer
// contextBridge：用于安全暴露API给渲染进程，开启contextIsolation时必须用
// ipcRenderer：渲染进程调用主进程IPC通信的对象
import { contextBridge, ipcRenderer } from 'electron'

// 导入@electron‑toolkit提供的内置electronAPI，封装了常用electron渲染进程方法
import { electronAPI } from '@electron-toolkit/preload'


// 定义自定义桌面API对象，存放我们自己的业务方法
const desktopAPI = {
  // 定义openPdf方法，返回Promise<string|null>
  openPdf: () => {
    // 调用主进程的IPC handle事件：document:open‑dialog
    // invoke：渲染进程发起调用，等待主进程返回结果，返回Promise
    return ipcRenderer.invoke('document:open-dialog')
  },
    ai: {
      getConfig: (): Promise<{
        backend: 'ollama' | 'api'
        apiBaseUrl: string
        apiKeySet: boolean
        apiModels: {
          translation: string
          chat: string
          vision: string
          embedding: string
        }
      }> => ipcRenderer.invoke('ai:get-config'),
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
      }): Promise<{
        backend: 'ollama' | 'api'
        apiBaseUrl: string
        apiKeySet: boolean
        apiModels: {
          translation: string
          chat: string
          vision: string
          embedding: string
        }
      }> => ipcRenderer.invoke('ai:save-config', request)
    },
    translator: {
      translate: (request: {
        text: string
        targetLanguage: 'zh' | 'en'
        action: 'translate' | 'explain' | 'rag' | 'selection-rag'
        prompt?: string
        webSearchEnabled?: boolean
      }): Promise<{ content: string; thinking?: string }> => {
        return ipcRenderer.invoke(
          'translator:translate',
          request
        )
      }
    },
    web: {
      getConfig: (): Promise<{
        provider: 'bing' | 'duckduckgo'
        proxyAddress: string
      }> => ipcRenderer.invoke('web:get-config'),
      setConfig: (request: {
        provider: 'bing' | 'duckduckgo'
        proxyAddress: string
      }): Promise<{
        provider: 'bing' | 'duckduckgo'
        proxyAddress: string
      }> => ipcRenderer.invoke('web:set-config', request),
      search: (request: {
        query: string
        limit?: number
      }): Promise<Array<{
        title: string
        url: string
        snippet: string
      }>> => ipcRenderer.invoke('web:search', request)
    },
    rag: {
      indexDocument: (request: {
        filePath: string
        chunks: Array<{ id: string; pageNumber: number; text: string }>
      }): Promise<{ cached: boolean; chunkCount: number }> => {
        return ipcRenderer.invoke('rag:index-document', request)
      },
      search: (request: {
        filePath: string
        query: string
        limit?: number
      }): Promise<Array<{ pageNumber: number; text: string; score: number }>> => {
        return ipcRenderer.invoke('rag:search', request)
      }
    },
    // 当前页图片理解：仅把渲染后的页面图片发送给主进程，模型和网络请求不暴露给渲染进程。
    vision: {
      analyze: (request: {
        imageBase64: string
        pageNumber: number
        question: string
      }): Promise<{ content: string }> => {
        return ipcRenderer.invoke('vision:analyze', request)
      }
    },
    models: {
      getState: (): Promise<{
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
      }> => ipcRenderer.invoke('models:get-state'),
      select: (request: {
        role: 'translation' | 'chat' | 'vision'
        modelId: string
      }) => ipcRenderer.invoke('models:select', request),
      download: (request: { modelId: string }) =>
        ipcRenderer.invoke('models:download', request),
      downloadAndSelect: (request: {
        role: 'translation' | 'chat' | 'vision'
        modelId: string
      }) => ipcRenderer.invoke('models:download-and-select', request)
    }
}

contextBridge.exposeInMainWorld('electron', electronAPI) // 暴露内置electronAPI给渲染进程
contextBridge.exposeInMainWorld('desktop', desktopAPI) // 暴露自定义desktopAPI给渲染进程
