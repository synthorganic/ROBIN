export interface LMStudioConfig {
  baseUrl: string;
  defaultModelId?: string;
}

export interface LMStudioState extends LMStudioConfig {
  isConnected: boolean;
  models: Array<{ id: string; name?: string }>;
}
