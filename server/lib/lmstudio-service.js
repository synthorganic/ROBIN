/**
 * LMStudio API Service
 *
 * Connects to local LMStudio instance and provides unified interfaces.
 */
import { randomUUID } from 'crypto';
class LMStudioService {
    baseUrl;
    apiKey;
    constructor(config = {}) {
        this.baseUrl = config.baseUrl || 'http://localhost:1234';
        this.apiKey = config.apiKey;
    }
    async ping() {
        try {
            const res = await fetch(this.baseUrl + '/health');
            return res.ok;
        }
        catch {
            return false;
        }
    }
    async getModels() {
        try {
            const res = await fetch(this.baseUrl + '/v1/models');
            const data = (await res.json());
            return data.data || [];
        }
        catch (error) {
            console.error('[LMStudio] Failed to get models:', error);
            throw error;
        }
    }
    async getCurrentModel() {
        try {
            const res = await fetch(this.baseUrl + '/v1/models');
            const data = (await res.json());
            return data.active_model || data.data?.[0] || null;
        }
        catch (error) {
            console.error('[LMStudio] Failed to get current model:', error);
            return null;
        }
    }
    async createChatCompletion(request) {
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
                const errorData = (await res.json());
                throw new Error(errorData.error?.message || 'LMStudio API error');
            }
            return (await res.json());
        }
        catch (error) {
            console.error('[LMStudio Chat] Completion failed:', error);
            throw error;
        }
    }
}
// Singleton instance
export const lmStudioService = new LMStudioService();
