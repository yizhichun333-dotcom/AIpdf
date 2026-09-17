import { app, ipcMain } from 'electron'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { getAiConfig } from './ai-config.ipc'

export type ModelRole = 'translation' | 'chat' | 'vision'

export interface ModelCandidate {
  id: string
  label: string
  description: string
  size: string
  role: ModelRole
}

export interface ModelPreferences {
  translation: string
  chat: string
  vision: string
}

export interface ModelState {
  candidates: ModelCandidate[]
  installedModelIds: string[]
  preferences: ModelPreferences
}

interface OllamaTagsResponse {
  models?: Array<{ name?: string }>
}

const OLLAMA_URL = 'http://localhost:11434'
const candidates: ModelCandidate[] = [
  {
    id: 'translategemma:latest',
    label: 'TranslateGemma 4B',
    description: 'PDF 翻译',
    size: '3.3 GB',
    role: 'translation'
  },
  {
    id: 'qwen3:4b',
    label: 'Qwen3 4B',
    description: 'PDF 讲解、问答与 RAG',
    size: '2.5 GB',
    role: 'chat'
  },
  {
    id: 'qwen3:8b',
    label: 'Qwen3 8B',
    description: '更强的 PDF 讲解、问答与 RAG',
    size: '5.2 GB',
    role: 'chat'
  },
  {
    id: 'qwen3-vl:4b',
    label: 'Qwen3-VL 4B',
    description: '流程图、实验图与表格识别（推荐）',
    size: '3.3 GB',
    role: 'vision'
  },
  {
    id: 'gemma3:4b',
    label: 'Gemma 3 4B',
    description: '多语言图文理解',
    size: '3.3 GB',
    role: 'vision'
  }
]

const defaultPreferences: ModelPreferences = {
  translation: 'translategemma:latest',
  chat: 'qwen3:4b',
  vision: 'qwen3-vl:4b'
}

const getPreferencesPath = (): string =>
  join(app.getPath('userData'), 'model-preferences.json')

// 支持 Ollama 常见的模型名与命名空间，例如 qwen3-vl:4b、hf.co/user/model:tag。
const isValidModelId = (modelId: string): boolean =>
  /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/.test(modelId)

const readPreferences = async (): Promise<ModelPreferences> => {
  try {
    const saved = JSON.parse(
      await readFile(getPreferencesPath(), 'utf8')
    ) as Partial<ModelPreferences>
    return {
      translation: isValidModelId(saved.translation ?? '')
        ? saved.translation!
        : defaultPreferences.translation,
      chat: isValidModelId(saved.chat ?? '')
        ? saved.chat!
        : defaultPreferences.chat,
      vision: isValidModelId(saved.vision ?? '')
        ? saved.vision!
        : defaultPreferences.vision
    }
  } catch {
    return defaultPreferences
  }
}

const writePreferences = async (
  preferences: ModelPreferences
): Promise<void> => {
  await mkdir(app.getPath('userData'), { recursive: true })
  await writeFile(
    getPreferencesPath(),
    JSON.stringify(preferences, null, 2),
    'utf8'
  )
}

const getInstalledModelIds = async (): Promise<string[]> => {
  const response = await fetch(`${OLLAMA_URL}/api/tags`)
  if (!response.ok) {
    throw new Error('无法连接 Ollama，请确认其正在运行')
  }

  const result = (await response.json()) as OllamaTagsResponse
  return (result.models ?? [])
    .map((model) => model.name)
    .filter((name): name is string => Boolean(name))
}

const getModelState = async (): Promise<ModelState> => {
  const aiConfig = await getAiConfig()
  let installedModelIds: string[] = []

  // API 模式不要求本机启动 Ollama；仍返回空的本地模型列表，方便界面
  // 明确提示“当前使用 API”，而不是误报为应用故障。
  try {
    installedModelIds = await getInstalledModelIds()
  } catch (error) {
    if (aiConfig.backend === 'ollama') {
      throw error
    }
  }

  return {
    candidates,
    installedModelIds,
    preferences: await readPreferences()
  }
}

const pullModel = async (modelId: string): Promise<void> => {
  if (!isValidModelId(modelId)) {
    throw new Error('模型名格式无效')
  }

  const response = await fetch(`${OLLAMA_URL}/api/pull`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: modelId, stream: false })
  })
  if (!response.ok) {
    throw new Error(`模型下载失败：${response.status}`)
  }
}

export const getConfiguredModel = async (
  role: ModelRole
): Promise<string> => {
  const preferences = await readPreferences()
  return preferences[role]
}

export function registerModelIpc(): void {
  ipcMain.handle('models:get-state', async (): Promise<ModelState> => {
    return getModelState()
  })

  ipcMain.handle(
    'models:select',
    async (
      _event,
      request: { role: ModelRole; modelId: string }
    ): Promise<ModelState> => {
      if (!isValidModelId(request.modelId)) {
        throw new Error('模型名格式无效')
      }

      const installedModelIds = await getInstalledModelIds()
      if (!installedModelIds.includes(request.modelId)) {
        throw new Error('请先下载模型，再将其设为默认模型')
      }

      const preferences = await readPreferences()
      preferences[request.role] = request.modelId
      await writePreferences(preferences)
      return getModelState()
    }
  )

  ipcMain.handle(
    'models:download',
    async (
      _event,
      request: { modelId: string }
    ): Promise<ModelState> => {
      await pullModel(request.modelId)
      return getModelState()
    }
  )

  ipcMain.handle(
    'models:download-and-select',
    async (
      _event,
      request: { role: ModelRole; modelId: string }
    ): Promise<ModelState> => {
      await pullModel(request.modelId)
      const preferences = await readPreferences()
      preferences[request.role] = request.modelId
      await writePreferences(preferences)
      return getModelState()
    }
  )
}
