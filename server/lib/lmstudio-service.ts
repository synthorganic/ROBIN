/**
 * LMStudio API Service
 *
 * Connects to local LMStudio instance and provides unified interfaces.
 */
import { randomUUID } from 'crypto';

export interface LMStudioConfig {
  baseUrl?: string;
  apiKey?: string;
  defaultModelId?: string;
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

class LMStudioService {
  private baseUrl: string;
  private apiKey?: string;

  constructor(config: LMStudioConfig = {}) {
    this.baseUrl = config.baseUrl || 'http://localhost:1234';
    this.apiKey = config.apiKey;
  }

  async ping(): Promise<boolean> {
    try {
      const res = await fetch(this.baseUrl + '/health');
      return res.ok;
    } catch {
      return false;
    }
  }

  async getModels(): Promise<Array<{ id: string; name?: string }>> {
    try {
      const res = await fetch(this.baseUrl + '/v1/models');
      const data = (await res.json()) as any;
      return data.data || [];
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
      const res = await fetch(this.baseUrl + '/v1/models');
      const data = (await res.json()) as any;
      return data.active_model || data.data?.[0] || null;
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
  }): Promise<ChatCompletionResponse> {
    const { messages, modelId, temperature = 0.7, maxTokens, stream = false } = request;

    try {
      const res = await fetch(this.baseUrl + '/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.apiKey ? { Authorization: 'Bearer ' + this.apiKey } : {}),
        },
        body: JSON.stringify({
          messages,
          model: modelId,
          temperature,
          max_tokens: maxTokens,
          stream,
        }),
      });

      if (!res.ok) {
        const errorData = (await res.json()) as FetchErrorData;
        throw new Error(
          errorData.error?.message || 'LMStudio API error'
        );
      }

      return (await res.json()) as ChatCompletionResponse;
    } catch (error) {
      console.error('[LMStudio Chat] Completion failed:', error);
      throw error;
    }
  }
}

// Singleton instance
export const lmStudioService = new LMStudioService();
