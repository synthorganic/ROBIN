/**
 * LMStudio API Service
 *
 * Connects to local LMStudio instance and provides unified interfaces.
 */
export interface LMStudioConfig {
  baseUrl?: string;
  apiKey?: string;
  defaultModelId?: string;
}

export interface LMStudioPublicConfig {
  baseUrl: string;
  apiKeySet: boolean;
  defaultModelId: string;
}

export interface LMStudioModel {
  id: string;
  name?: string;
  object?: string;
  created?: number;
}

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  name?: string;
}

export interface ToolCallFunction {
  name: string;
  arguments: string;
}

export interface ToolCall {
  id: string;
  function: ToolCallFunction;
  type: string;
}

export interface ChatCompletionChoiceMessage {
  role: 'assistant';
  content?: string | null;
  reasoning_content?: string | null;
  tool_calls?: ToolCall[];
}

export interface ChatCompletionResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: ChatCompletionChoiceMessage;
    finish_reason: 'stop' | 'length' | 'tool_calls';
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface FetchErrorData {
  error?: {
    message?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

const DEFAULT_BASE_URL = 'http://127.0.0.1:1234';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function normalizeLocalApiBaseUrl(value: string | undefined) {
  const raw = (value || DEFAULT_BASE_URL).trim() || DEFAULT_BASE_URL;
  const withProtocol = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
  try {
    const url = new URL(withProtocol);
    if (!url.port && (url.hostname === 'localhost' || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(url.hostname))) {
      url.port = '1234';
    }
    url.pathname = url.pathname.replace(/\/+$/, '');
    return url.toString().replace(/\/$/, '');
  } catch {
    return DEFAULT_BASE_URL;
  }
}

function normalizeModel(value: unknown): LMStudioModel | null {
  if (!isRecord(value)) return null;
  const id = typeof value.id === 'string' ? value.id.trim() : '';
  if (!id) return null;
  return {
    id,
    name: typeof value.name === 'string' && value.name.trim() ? value.name.trim() : undefined,
    object: typeof value.object === 'string' ? value.object : undefined,
    created: typeof value.created === 'number' ? value.created : undefined,
  };
}

function parseModels(data: unknown) {
  if (!isRecord(data)) return [];
  const rawModels = Array.isArray(data.data)
    ? data.data
    : Array.isArray(data.models)
      ? data.models
      : [];
  return rawModels
    .map((item) => normalizeModel(item))
    .filter((item): item is LMStudioModel => Boolean(item));
}

function parseErrorMessage(data: unknown) {
  if (!isRecord(data)) return '';
  const error = data.error;
  if (typeof error === 'string') return error;
  if (isRecord(error) && typeof error.message === 'string') return error.message;
  if (typeof data.message === 'string') return data.message;
  return '';
}

class LMStudioService {
  private baseUrl: string;
  private apiKey: string;
  private defaultModelId: string;

  constructor(config: LMStudioConfig = {}) {
    this.baseUrl = normalizeLocalApiBaseUrl(
      config.baseUrl || process.env.LOCAL_API_BASE_URL || process.env.LMSTUDIO_BASE_URL,
    );
    this.apiKey = config.apiKey ?? process.env.LOCAL_API_KEY ?? process.env.LMSTUDIO_API_KEY ?? '';
    this.defaultModelId = config.defaultModelId ?? process.env.LOCAL_API_MODEL ?? process.env.LMSTUDIO_MODEL ?? '';
  }

  configure(config: LMStudioConfig) {
    if (config.baseUrl !== undefined) this.baseUrl = normalizeLocalApiBaseUrl(config.baseUrl);
    if (config.apiKey !== undefined) this.apiKey = config.apiKey.trim();
    if (config.defaultModelId !== undefined) this.defaultModelId = config.defaultModelId.trim();
  }

  publicConfig(): LMStudioPublicConfig {
    return {
      baseUrl: this.baseUrl,
      apiKeySet: Boolean(this.apiKey),
      defaultModelId: this.defaultModelId,
    };
  }

  private resolveConfig(config?: LMStudioConfig) {
    return {
      baseUrl: normalizeLocalApiBaseUrl(config?.baseUrl || this.baseUrl),
      apiKey: config?.apiKey !== undefined ? config.apiKey.trim() : this.apiKey,
      defaultModelId: config?.defaultModelId !== undefined ? config.defaultModelId.trim() : this.defaultModelId,
    };
  }

  private headers(config?: LMStudioConfig) {
    const resolved = this.resolveConfig(config);
    return {
      'Content-Type': 'application/json',
      ...(resolved.apiKey ? { Authorization: `Bearer ${resolved.apiKey}` } : {}),
    };
  }

  async ping(): Promise<boolean> {
    try {
      const res = await fetch(this.baseUrl + '/health');
      return res.ok;
    } catch {
      return false;
    }
  }

  async getModels(config?: LMStudioConfig): Promise<LMStudioModel[]> {
    const resolved = this.resolveConfig(config);
    try {
      const res = await fetch(`${resolved.baseUrl}/v1/models`, {
        headers: this.headers(resolved),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(parseErrorMessage(data) || `Model endpoint returned ${res.status}`);
      }
      return parseModels(data);
    } catch (error) {
      console.error('[LMStudio] Failed to get models:', error);
      throw error;
    }
  }

  async getCurrentModel(): Promise<{
    id: string;
    object: string;
    created: number;
    provider: string;
  } | null> {
    try {
      const res = await fetch(this.baseUrl + '/v1/models', {
        headers: this.headers(),
      });
      const data = await res.json().catch(() => ({}));
      if (!isRecord(data)) return null;
      const activeModel = normalizeModel(data.active_model) || parseModels(data)[0];
      if (!activeModel) return null;
      return {
        id: activeModel.id,
        object: activeModel.object || 'model',
        created: activeModel.created || 0,
        provider: 'local',
      };
    } catch (error) {
      console.error('[LMStudio] Failed to get current model:', error);
      return null;
    }
  }

  async createChatCompletion(request: {
    messages: ChatMessage[];
    modelId?: string;
    temperature?: number;
    maxTokens?: number;
    stream?: boolean;
    baseUrl?: string;
    apiKey?: string;
  }): Promise<ChatCompletionResponse> {
    const {
      messages,
      modelId,
      temperature = 0.7,
      maxTokens,
      stream = false,
      baseUrl,
      apiKey,
    } = request;
    const resolved = this.resolveConfig({ baseUrl, apiKey, defaultModelId: modelId });
    const selectedModel = modelId || resolved.defaultModelId;
    if (!selectedModel) {
      throw new Error('Select a local model before sending a chat message.');
    }

    try {
      const res = await fetch(`${resolved.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: this.headers(resolved),
        body: JSON.stringify({
          messages,
          model: selectedModel,
          temperature,
          max_tokens: maxTokens,
          stream,
        }),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(parseErrorMessage(data) || 'LMStudio API error');
      }

      return data as ChatCompletionResponse;
    } catch (error) {
      console.error('[LMStudio Chat] Completion failed:', error);
      throw error;
    }
  }
}

// Singleton instance
export const lmStudioService = new LMStudioService();
