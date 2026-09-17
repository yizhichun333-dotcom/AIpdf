import { app, ipcMain, safeStorage } from 'electron'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export type AiBackend = 'ollama' | 'api'
export type AiRole = 'translation' | 'chat' | 'vision' | 'embedding'

// 每个功能拥有自己的模型配置；修改其中一项不会影响其他功能。
export interface ApiModelConfig {
  translation: string
  chat: string
  vision: string
  embedding: string
}

export interface AiConfigView {
  backend: AiBackend
  apiBaseUrl: string
  apiKeySet: boolean
  apiModels: ApiModelConfig
}

export interface SaveAiConfigRequest {
  backend: AiBackend
  apiBaseUrl: string
  apiKey?: string
  clearApiKey?: boolean
  apiModels: ApiModelConfig
}

export interface AiRuntimeConfig {
  backend: AiBackend
  apiBaseUrl: string
  apiKey: string
  model: string
}

interface StoredAiConfig {
  backend: AiBackend
  apiBaseUrl: string
  apiKeyEncrypted?: string
  // 这是 API 服务自己的模型配置；本地 Ollama 模型仍由 model.ipc 管理。
  apiModels: ApiModelConfig
}

interface StoredAiConfigInput {
  backend?: AiBackend
  apiBaseUrl?: string
  apiKeyEncrypted?: string
  apiModels?: Partial<ApiModelConfig>
  // 兼容上一版“默认模型 + 覆盖模型”的配置格式。
  apiModelProfile?: {
    defaultModel?: string
    overrides?: Partial<ApiModelConfig>
  }
}

const emptyApiModels = (): ApiModelConfig => ({
  translation: '',
  chat: '',
  vision: '',
  embedding: ''
})

const defaultAiConfig: StoredAiConfig = {
  backend: 'ollama',
  apiBaseUrl: '',
  apiModels: emptyApiModels()
}

const getAiConfigPath = (): string =>
  join(app.getPath('userData'), 'ai-config.json')

const normalizeApiBaseUrl = (value: string): string => {
  const baseUrl = value.trim().replace(/\/+$/, '')
  if (!baseUrl) {
    return ''
  }

  const parsed = new URL(baseUrl)
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('API 地址必须使用 http 或 https')
  }

  return parsed.href.replace(/\/+$/, '')
}

const normalizeApiModels = (
  value: Partial<ApiModelConfig> | undefined
): ApiModelConfig => ({
  translation: value?.translation?.trim() ?? '',
  chat: value?.chat?.trim() ?? '',
  vision: value?.vision?.trim() ?? '',
  embedding: value?.embedding?.trim() ?? ''
})

const migratePreviousProfile = (
  profile: StoredAiConfigInput['apiModelProfile']
): ApiModelConfig => {
  const defaultModel = profile?.defaultModel?.trim() ?? ''
  const overrides = normalizeApiModels(profile?.overrides)
  return {
    translation: overrides.translation || defaultModel,
    chat: overrides.chat || defaultModel,
    vision: overrides.vision || defaultModel,
    embedding: overrides.embedding || defaultModel
  }
}

const normalizeStoredConfig = (
  value: StoredAiConfigInput | undefined
): StoredAiConfig => ({
  backend: value?.backend === 'api' ? 'api' : 'ollama',
  apiBaseUrl: normalizeApiBaseUrl(value?.apiBaseUrl ?? ''),
  apiKeyEncrypted:
    typeof value?.apiKeyEncrypted === 'string'
      ? value.apiKeyEncrypted
      : undefined,
  apiModels: value?.apiModels
    ? normalizeApiModels(value.apiModels)
    : migratePreviousProfile(value?.apiModelProfile)
})

const readStoredConfig = async (): Promise<StoredAiConfig> => {
  try {
    return normalizeStoredConfig(
      JSON.parse(
        await readFile(getAiConfigPath(), 'utf8')
      ) as StoredAiConfigInput
    )
  } catch {
    return defaultAiConfig
  }
}

const writeStoredConfig = async (
  config: StoredAiConfig
): Promise<void> => {
  await mkdir(app.getPath('userData'), { recursive: true })
  await writeFile(
    getAiConfigPath(),
    JSON.stringify(config, null, 2),
    'utf8'
  )
}

const decryptApiKey = (encrypted: string | undefined): string => {
  if (!encrypted || !safeStorage.isEncryptionAvailable()) {
    return ''
  }

  try {
    return safeStorage.decryptString(Buffer.from(encrypted, 'base64'))
  } catch {
    return ''
  }
}

export const getAiConfig = async (): Promise<AiConfigView> => {
  const config = await readStoredConfig()
  return {
    backend: config.backend,
    apiBaseUrl: config.apiBaseUrl,
    apiKeySet: Boolean(decryptApiKey(config.apiKeyEncrypted)),
    apiModels: config.apiModels
  }
}

export const getAiRuntimeConfig = async (
  role: AiRole
): Promise<AiRuntimeConfig> => {
  const config = await readStoredConfig()
  const model = config.apiModels[role]

  if (config.backend === 'api') {
    if (!config.apiBaseUrl) {
      throw new Error('请先配置 API 地址')
    }
    if (!model) {
      throw new Error(`请先配置 API 的${role}模型名称`)
    }
  }

  return {
    backend: config.backend,
    apiBaseUrl: config.apiBaseUrl,
    apiKey: decryptApiKey(config.apiKeyEncrypted),
    model
  }
}

const saveAiConfig = async (
  request: SaveAiConfigRequest
): Promise<AiConfigView> => {
  const backend: AiBackend = request.backend === 'api' ? 'api' : 'ollama'
  const apiBaseUrl = normalizeApiBaseUrl(request.apiBaseUrl ?? '')
  const apiModels = normalizeApiModels(request.apiModels)
  if (backend === 'api' && !apiBaseUrl) {
    throw new Error('API 模式必须填写 API 地址')
  }

  const current = await readStoredConfig()
  let apiKeyEncrypted = current.apiKeyEncrypted

  if (request.clearApiKey) {
    apiKeyEncrypted = undefined
  } else if (request.apiKey?.trim()) {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('当前系统无法安全保存 API Key')
    }
    apiKeyEncrypted = safeStorage
      .encryptString(request.apiKey.trim())
      .toString('base64')
  }

  await writeStoredConfig({ backend, apiBaseUrl, apiKeyEncrypted, apiModels })
  return getAiConfig()
}

export function registerAiConfigIpc(): void {
  ipcMain.handle('ai:get-config', async (): Promise<AiConfigView> => getAiConfig())
  ipcMain.handle(
    'ai:save-config',
    async (
      _event,
      request: SaveAiConfigRequest
    ): Promise<AiConfigView> => saveAiConfig(request)
  )
}
