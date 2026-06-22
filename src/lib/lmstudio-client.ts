/**
 * LMStudio Client for Browser
 * Simple interface to your LMStudio instance at localhost:1234
 */

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface ChatCompletionResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: 'assistant';
      content: string;
      reasoning_content?: string;
      tool_calls?: Array<{
        id: string;
        function: { name: string; arguments: string };
        type: string;
      }>;
    };
    finish_reason: 'stop' | 'length';
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

interface LMStudioErrorResponse {
  error?: {
    message?: string;
  };
}

interface LMStudioStreamChunk {
  choices?: Array<{
    delta?: {
      content?: string;
    };
  }>;
}

const DEFAULT_MODEL = 'huihui-ai_qwen3-coder-next-abliterated@iq4_nl';

export async function chatCompletion(
  messages: ChatMessage[],
  options?: {
    model?: string;
    temperature?: number;
    maxTokens?: number;
  }
): Promise<ChatCompletionResponse> {
  const { model = DEFAULT_MODEL, temperature = 0.7, maxTokens } = options || {};

  const response = await fetch('http://localhost:1234/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages,
      temperature,
      max_tokens: maxTokens,
    }),
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({} as LMStudioErrorResponse));
    throw new Error(errorData.error?.message || 'LMStudio API error');
  }

  return await response.json();
}

export async function* streamChat(
  messages: ChatMessage[],
  options?: {
    model?: string;
    temperature?: number;
    maxTokens?: number;
  }
): AsyncGenerator<string> {
  const { model = DEFAULT_MODEL, temperature = 0.7, maxTokens } = options || {};

  const response = await fetch('http://localhost:1234/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    },
    body: JSON.stringify({
      model,
      messages,
      temperature,
      max_tokens: maxTokens,
      stream: true,
    }),
  });

  if (!response.ok) {
    throw new Error();
  }

  const reader = response.body?.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  if (reader) {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6);
          if (data === '[DONE]') continue;

          try {
            const json = JSON.parse(data) as LMStudioStreamChunk;
            const content = json.choices?.[0]?.delta?.content || '';
            if (content) {
              yield content;
            }
          } catch {
            // Skip non-JSON lines
          }
        }
      }
    }
  }
}
