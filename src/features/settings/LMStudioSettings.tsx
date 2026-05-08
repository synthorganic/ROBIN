import { useState, useEffect } from 'react';
import {
  Settings,
  Cpu,
  RefreshCw,
} from 'lucide-react';

export interface LMStudioConfig {
  baseUrl: string;
  defaultModelId?: string;
}

interface LMStudioSettingsProps {
  config: LMStudioConfig;
  onChange: (config: LMStudioConfig) => void;
}

const DEFAULT_MODELS: Array<{ id: string; name: string }> = [
  { id: 'huihui-ai_qwen3-coder-next-abliterated@iq4_nl', name: 'Qwen3 Coder Next' },
  { id: 'atlas coder 26b-a4b@?', name: 'Atlas Coder 26B' },
  { id: 'qwen3.5-13b-deckard-heretic-uncensored-thinking', name: 'Qwen3.5 13B Deckard' },
];

export function LMStudioSettings({ config, onChange }: LMStudioSettingsProps) {
  const [url, setUrl] = useState(config.baseUrl);
  const [selectedModelId, setSelectedModelId] = useState(
    config.defaultModelId || 'huihui-ai_qwen3-coder-next-abliterated@iq4_nl'
  );
  const [isConnected, setIsConnected] = useState(false);
  const [isLoadingModels, setIsLoadingModels] = useState(false);
  const [availableModels, setAvailableModels] = useState<Array<{
    id: string;
    name?: string;
  }>>([]);
  const modelOptions = availableModels.length > 0 ? availableModels : DEFAULT_MODELS;

  useEffect(() => {
    fetchModels();
  }, [url]);

  const fetchModels = async () => {
    setIsLoadingModels(true);
    try {
      const res = await fetch(config.baseUrl + '/v1/models');
      if (res.ok) {
        const data = await res.json();
        setAvailableModels(data.data || []);
        setIsConnected(true);
      }
    } catch (error) {
      console.error('[LMStudio] Failed to fetch models:', error);
      setIsConnected(false);
    } finally {
      setIsLoadingModels(false);
    }
  };

  useEffect(() => {
    onChange({
      baseUrl: url,
      defaultModelId: selectedModelId,
    });
  }, [onChange, selectedModelId, url]);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-medium">LMStudio API</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Configure your local LMStudio instance for model access.
          </p>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <label className="cockpit-field">
          <span className="cockpit-field-label flex items-center gap-2">
            <Settings size={14} />
            LMStudio URL
          </span>
          <input
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onBlur={fetchModels}
            placeholder="http://localhost:1234"
            className="cockpit-input cockpit-input-mono"
          />
          <span className="cockpit-field-hint">
            Your LMStudio API endpoint ({isConnected ? 'connected' : 'offline'})
          </span>
        </label>

        <div className="space-y-2">
          <label className="cockpit-field-label flex items-center gap-2">
            <Cpu size={14} />
            Default Model
          </label>
          <select
            value={selectedModelId}
            onChange={(e) => setSelectedModelId(e.target.value)}
            className="cockpit-input cockpit-input-mono">
            {modelOptions.map((model) => (
              <option key={model.id} value={model.id}>
                {model.name || model.id}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="flex items-center gap-3 pt-4">
        <button
          onClick={fetchModels}
          disabled={isLoadingModels}
          className="inline-flex items-center gap-2 rounded-md px-4 py-2 text-sm font-medium transition-colors hover:bg-muted focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50">
          <RefreshCw size={16} className={`transition-transform ${isLoadingModels ? 'animate-spin' : ''}`} />
          Refresh Models
        </button>
      </div>
    </div>
  );
}
