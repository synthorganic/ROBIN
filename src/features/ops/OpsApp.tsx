import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  BarChart3,
  Biohazard,
  Bot,
  Brain,
  Camera,
  ChevronRight,
  Code2,
  CornerDownLeft,
  DatabaseZap,
  FileText,
  FileUp,
  Flame,
  Folder,
  Globe2,
  KeyRound,
  Layers3,
  LoaderCircle,
  LogOut,
  MapPinned,
  Route,
  Orbit,
  Paperclip,
  Plane,
  Play,
  RadioTower,
  RefreshCw,
  Satellite,
  Send,
  ShieldCheck,
  Square,
  TerminalSquare,
  Trash2,
  Upload,
  Wrench,
} from 'lucide-react';
import AnimatedTraceList, { type AnimatedTraceItem } from './AnimatedTraceList';
import BridgeWorkflowPanel from './BridgeWorkflowPanel';
import FuzzyText from './FuzzyText';
import LeafletMap from './LeafletMap';
import MapAssetInspector from './MapAssetInspector';
import TextType from './TextType';
import {
  opsApi,
  type AgentMessage,
  type AgentSession,
  type AgentToolCall,
  type AgentToolCatalog,
  type AgentToolCatalogItem,
  type AgentTransport,
  type ApiKeyStatus,
  type BridgeStatus,
  type LocalApiModel,
  type LocalApiStatus,
  type MapAsset,
  type MapLayer,
  type MapSourceStatus,
  type OpsDocument,
  type TerminalState,
} from './api';
import './ops.css';

type OpsTab = 'map' | 'status' | 'agent';
type RailMode = 'chat' | 'briefings';
type SignalFamily = 'logistics' | 'biological' | 'ordnance' | 'nuclear' | 'general';

interface OpsAppProps {
  onLogout: () => Promise<void>;
}

const SIGNAL_FAMILIES: Array<{
  id: SignalFamily;
  label: string;
  description: string;
}> = [
  { id: 'logistics', label: 'Logistics', description: 'Routes, cargo, shipping, and supply movement.' },
  { id: 'biological', label: 'Bio Signals', description: 'Medical, bio, or contamination-linked indicators.' },
  { id: 'ordnance', label: 'Ordnance', description: 'Weapons, strike, or munitions-linked signals.' },
  { id: 'nuclear', label: 'Nuclear', description: 'Radiological, reactor, or nuclear-adjacent activity.' },
  { id: 'general', label: 'General Intel', description: 'Unclassified notes, reports, and general watch items.' },
];

function emptyBridge(): BridgeStatus {
  return { activeJob: null, recentJobs: [] };
}

function latestAssistantMessage(history: AgentMessage[] | undefined) {
  if (!history) return '';
  for (let index = history.length - 1; index >= 0; index -= 1) {
    if (history[index].role === 'assistant') return history[index].text;
  }
  return '';
}

function latestUserMessage(history: AgentMessage[] | undefined) {
  if (!history) return '';
  for (let index = history.length - 1; index >= 0; index -= 1) {
    if (history[index].role === 'user') return history[index].text;
  }
  return '';
}

const emptyTerminal = (
  id: TerminalState['id'],
  label: string,
  role: TerminalState['role'],
  readonly: boolean,
): TerminalState => ({
  id,
  label,
  role,
  running: id === 'logs',
  cols: 120,
  rows: 28,
  readonly,
  lastUpdated: Date.now(),
  pid: null,
  buffer: [],
});

function formatError(error: unknown) {
  if (error instanceof Error) return error.message;
  return String(error);
}

function assetMatchesQuery(asset: MapAsset, query: string) {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return true;

  return [
    asset.title,
    asset.type,
    asset.sourceUrl,
    asset.streamUrl ?? '',
    asset.notes ?? '',
    asset.status ?? '',
    asset.linkedSessionId ?? '',
    asset.tags.join(' '),
  ]
    .join(' ')
    .toLowerCase()
    .includes(normalizedQuery);
}

function formatClock(value: string | number | null | undefined) {
  if (!value) return 'Unavailable';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Unavailable';
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatRelative(value: string | number | null | undefined) {
  if (!value) return 'just now';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'just now';
  const elapsedMs = Date.now() - date.getTime();
  const minute = 60_000;
  const hour = 60 * minute;
  if (elapsedMs < minute) return 'just now';
  if (elapsedMs < hour) return `${Math.round(elapsedMs / minute)}m ago`;
  return `${Math.round(elapsedMs / hour)}h ago`;
}

function classifyAssetFamily(asset: MapAsset): SignalFamily {
  const haystack = [
    asset.title,
    asset.type,
    asset.sourceUrl,
    asset.streamUrl ?? '',
    asset.notes ?? '',
    asset.status ?? '',
    asset.tags.join(' '),
  ]
    .join(' ')
    .toLowerCase();

  if (/(nuclear|reactor|radiological|uranium|plutonium|isotope)/.test(haystack)) return 'nuclear';
  if (/(bio|biological|pathogen|medical|clinical|plume|contamination)/.test(haystack)) return 'biological';
  if (/(ordnance|munition|weapon|missile|explosive|strike|launch)/.test(haystack)) return 'ordnance';
  if (/(logistics|route|cargo|port|shipping|vessel|supply|dock|freight|flight|aircraft|aviation|ads-b)/.test(haystack)) return 'logistics';
  return 'general';
}

function familyLabel(family: SignalFamily) {
  return SIGNAL_FAMILIES.find((entry) => entry.id === family)?.label ?? 'General Intel';
}

function familyIcon(family: SignalFamily) {
  switch (family) {
    case 'logistics':
      return <Folder size={16} />;
    case 'biological':
      return <Biohazard size={16} />;
    case 'ordnance':
      return <AlertTriangle size={16} />;
    case 'nuclear':
      return <Orbit size={16} />;
    default:
      return <RadioTower size={16} />;
  }
}

function sourceKey(asset: MapAsset) {
  return asset.sourceId || 'manual';
}

function sourceLabel(sourceId: string, statuses: MapSourceStatus[]) {
  if (sourceId === 'manual') return 'Operator Assets';
  return statuses.find((source) => source.id === sourceId)?.name ?? sourceId.toUpperCase();
}

function sourceIcon(sourceId: string) {
  switch (sourceId) {
    case 'gdelt':
      return <Globe2 size={16} />;
    case 'gdacs':
      return <AlertTriangle size={16} />;
    case 'usgs':
      return <RadioTower size={16} />;
    case 'nws':
      return <ShieldCheck size={16} />;
    case 'firms':
      return <Flame size={16} />;
    case 'radnet':
      return <Orbit size={16} />;
    case 'trafficcams':
      return <Camera size={16} />;
    case 'trackedflights':
      return <Plane size={16} />;
    case 'eurdep':
      return <Globe2 size={16} />;
    case 'safecast':
      return <RadioTower size={16} />;
    case 'gmcmap':
      return <RadioTower size={16} />;
    case 'ntad':
      return <Route size={16} />;
    case 'faf':
      return <Folder size={16} />;
    case 'marinecadastre':
      return <Satellite size={16} />;
    case 'mobilitydb':
      return <RadioTower size={16} />;
    case 'tigerline':
      return <MapPinned size={16} />;
    default:
      return <Folder size={16} />;
  }
}

function sourceStatusTone(source: MapSourceStatus | undefined) {
  if (!source) return 'idle';
  if (source.catalogOnly) return 'catalog';
  if (!source.enabled) return 'muted';
  if (source.ok) return source.stale ? 'stale' : 'ok';
  return source.stale ? 'stale' : 'error';
}

function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

function groupDocumentsByProject(documents: OpsDocument[]) {
  const groups = new Map<string, OpsDocument[]>();
  for (const document of documents) {
    const project = document.project || 'General';
    groups.set(project, [...(groups.get(project) ?? []), document]);
  }
  return Array.from(groups.entries())
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([project, items]) => ({
      project,
      documents: items.sort((left, right) => right.uploadedAt.localeCompare(left.uploadedAt)),
    }));
}

function groupToolsByCategory(tools: AgentToolCatalogItem[]) {
  const groups = new Map<string, AgentToolCatalogItem[]>();
  for (const tool of tools) {
    groups.set(tool.category, [...(groups.get(tool.category) ?? []), tool]);
  }
  return Array.from(groups.entries())
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([category, items]) => ({
      category,
      tools: items.sort((left, right) => left.displayName.localeCompare(right.displayName)),
    }));
}

const THINK_TAG_PATTERN = /<\s*think\s*>([\s\S]*?)<\s*\/\s*think\s*>/gi;

function clampTraceText(value: string) {
  return value.trim().replace(/\n{3,}/g, '\n\n').slice(0, 2400);
}

function splitInlineReasoning(rawText: string) {
  const reasoning: string[] = [];
  const reply = String(rawText || '')
    .replace(THINK_TAG_PATTERN, (_match, body) => {
      const text = clampTraceText(String(body || ''));
      if (text) reasoning.push(text);
      return '';
    })
    .trim();
  return { reply, reasoning };
}

function reasoningToTraceItems(reasoning: string[] = []): AnimatedTraceItem[] {
  return reasoning
    .map(clampTraceText)
    .filter(Boolean)
    .map((text, index) => ({
      id: `reasoning-${index}`,
      label: `Reasoning ${index + 1}`,
      text,
    }));
}

function toolCallsToTraceItems(toolCalls: AgentToolCall[] = []): AnimatedTraceItem[] {
  return toolCalls.map((call, index) => {
    const name = call.name || 'tool';
    const type = call.type || 'tool';
    const args = call.arguments?.trim();
    return {
      id: `tool-${index}`,
      label: `${type} ${index + 1}`,
      text: clampTraceText(args ? `${name}\n${args}` : name),
    };
  });
}

export default function OpsApp({ onLogout }: OpsAppProps) {
  const [activeTab, setActiveTab] = useState<OpsTab>('map');
  const [railMode, setRailMode] = useState<RailMode>('chat');
  const [loading, setLoading] = useState(true);
  const [session, setSession] = useState<AgentSession | null>(null);
  const [bridge, setBridge] = useState<BridgeStatus>(emptyBridge());
  const [terminals, setTerminals] = useState<Record<TerminalState['id'], TerminalState>>({
    cli: emptyTerminal('cli', 'ROBIN CLI Agent', 'cli-agent', false),
    support: emptyTerminal('support', 'Support Shell', 'support-shell', false),
    logs: emptyTerminal('logs', 'Bridge / Logs', 'bridge-log', true),
  });
  const [prompt, setPrompt] = useState('');
  const [sending, setSending] = useState(false);
  const [assets, setAssets] = useState<MapAsset[]>([]);
  const [layers, setLayers] = useState<MapLayer[]>([]);
  const [sourceStatuses, setSourceStatuses] = useState<MapSourceStatus[]>([]);
  const [sourceRefreshing, setSourceRefreshing] = useState(false);
  const [documents, setDocuments] = useState<OpsDocument[]>([]);
  const [documentProject, setDocumentProject] = useState('General');
  const [documentUploading, setDocumentUploading] = useState(false);
  const [documentDragActive, setDocumentDragActive] = useState(false);
  const [selectedDocumentIds, setSelectedDocumentIds] = useState<string[]>([]);
  const [toolCatalog, setToolCatalog] = useState<AgentToolCatalog | null>(null);
  const [selectedToolNames, setSelectedToolNames] = useState<string[]>([]);
  const [apiKeyStatus, setApiKeyStatus] = useState<ApiKeyStatus | null>(null);
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [apiKeySaving, setApiKeySaving] = useState(false);
  const [agentTransport, setAgentTransport] = useState<AgentTransport>(() => (
    localStorage.getItem('ops-agent-transport') === 'local' ? 'local' : 'gateway'
  ));
  const [localApiStatus, setLocalApiStatus] = useState<LocalApiStatus | null>(null);
  const [localApiBaseUrl, setLocalApiBaseUrl] = useState('http://127.0.0.1:1234');
  const [localApiKeyInput, setLocalApiKeyInput] = useState('');
  const [localApiModel, setLocalApiModel] = useState('');
  const [localApiModels, setLocalApiModels] = useState<LocalApiModel[]>([]);
  const [localApiSaving, setLocalApiSaving] = useState(false);
  const [localApiPolling, setLocalApiPolling] = useState(false);
  const [selectedAsset, setSelectedAsset] = useState<MapAsset | null>(null);
  const [mapQuery, setMapQuery] = useState('');
  const [clickedCoords, setClickedCoords] = useState<{ lat: number; lng: number } | null>(null);
  const [visibleFamilies, setVisibleFamilies] = useState<Record<SignalFamily, boolean>>({
    logistics: true,
    biological: true,
    ordnance: true,
    nuclear: true,
    general: true,
  });
  const [visibleSources, setVisibleSources] = useState<Record<string, boolean>>({
    manual: true,
    gdelt: true,
    gdacs: true,
    usgs: true,
    nws: true,
    firms: true,
    radnet: true,
    trafficcams: true,
    trackedflights: true,
    eurdep: true,
    safecast: true,
    gmcmap: true,
    ntad: true,
    faf: true,
    marinecadastre: true,
    mobilitydb: true,
    tigerline: true,
  });
  const [error, setError] = useState('');
  const [bridgeBusyAction, setBridgeBusyAction] = useState<'handoff' | 'return' | 'cancel' | null>(null);
  const chatScrollerRef = useRef<HTMLDivElement | null>(null);
  const sessionId = session?.id ?? null;
  const sessionIdRef = useRef<string | null>(null);

  useEffect(() => {
    sessionIdRef.current = sessionId;
  }, [sessionId]);

  const clearError = useCallback(() => {
    setError('');
  }, []);

  const handleError = useCallback((nextError: unknown) => {
    setError(formatError(nextError));
  }, []);

  const applyTerminalState = useCallback((terminal: TerminalState) => {
    setTerminals((current) => ({ ...current, [terminal.id]: terminal }));
  }, []);

  const applyTerminalStates = useCallback((nextTerminals: TerminalState[]) => {
    setTerminals((current) => {
      const next = { ...current };
      for (const terminal of nextTerminals) {
        next[terminal.id] = terminal;
      }
      return next;
    });
  }, []);

  const loadShellData = useCallback(async (mode: 'bootstrap' | 'refresh') => {
    setLoading(mode === 'bootstrap');
    try {
      const activeSessionId = sessionIdRef.current;
      const [
        sessionResult,
        terminalResult,
        bridgeResult,
        assetsResult,
        layersResult,
        sourcesResult,
        documentsResult,
        toolsResult,
        keysResult,
        localApiResult,
      ] = await Promise.allSettled([
        activeSessionId ? opsApi.getSession(activeSessionId) : opsApi.createSession(undefined, agentTransport),
        opsApi.listTerminals(),
        opsApi.getBridgeStatus(),
        opsApi.listAssets(),
        opsApi.listLayers(),
        opsApi.listSources(),
        opsApi.listDocuments(),
        opsApi.getAgentToolCatalog(),
        opsApi.getApiKeyStatus(),
        opsApi.getLocalApiStatus(),
      ]);

      if (sessionResult.status === 'fulfilled') {
        setSession(sessionResult.value.session);
      }

      if (terminalResult.status === 'fulfilled') {
        applyTerminalStates(terminalResult.value.terminals);
      }

      if (bridgeResult.status === 'fulfilled') {
        setBridge({ activeJob: bridgeResult.value.activeJob, recentJobs: bridgeResult.value.recentJobs });
      }

      if (assetsResult.status === 'fulfilled') {
        setAssets(assetsResult.value.assets);
      }

      if (layersResult.status === 'fulfilled') {
        setLayers(layersResult.value.layers);
      }

      if (sourcesResult.status === 'fulfilled') {
        setSourceStatuses(sourcesResult.value.sources);
      }

      if (documentsResult.status === 'fulfilled') {
        setDocuments(documentsResult.value.documents);
      }

      if (toolsResult.status === 'fulfilled') {
        setToolCatalog(toolsResult.value.catalog);
      }

      if (keysResult.status === 'fulfilled') {
        setApiKeyStatus(keysResult.value);
      }

      if (localApiResult.status === 'fulfilled') {
        setLocalApiStatus(localApiResult.value.localApi);
        setLocalApiBaseUrl(localApiResult.value.localApi.baseUrl);
        setLocalApiModel(localApiResult.value.localApi.defaultModelId);
      }

      const bootErrors = [
        sessionResult.status === 'rejected' ? `Central agent unavailable: ${formatError(sessionResult.reason)}` : '',
        terminalResult.status === 'rejected' ? `Terminal bus unavailable: ${formatError(terminalResult.reason)}` : '',
        bridgeResult.status === 'rejected' ? `Bridge status unavailable: ${formatError(bridgeResult.reason)}` : '',
        assetsResult.status === 'rejected' ? `Map assets unavailable: ${formatError(assetsResult.reason)}` : '',
        layersResult.status === 'rejected' ? `Map layers unavailable: ${formatError(layersResult.reason)}` : '',
        sourcesResult.status === 'rejected' ? `Map sources unavailable: ${formatError(sourcesResult.reason)}` : '',
        documentsResult.status === 'rejected' ? `Documents unavailable: ${formatError(documentsResult.reason)}` : '',
        toolsResult.status === 'rejected' ? `Agent tools unavailable: ${formatError(toolsResult.reason)}` : '',
        keysResult.status === 'rejected' ? `API key status unavailable: ${formatError(keysResult.reason)}` : '',
        localApiResult.status === 'rejected' ? `Local API config unavailable: ${formatError(localApiResult.reason)}` : '',
      ].filter(Boolean);
      setError(bootErrors.join(' | '));
    } finally {
      if (mode === 'bootstrap') setLoading(false);
    }
  }, [agentTransport, applyTerminalStates]);

  useEffect(() => {
    let mounted = true;
    void (async () => {
      await loadShellData('bootstrap');
      if (!mounted) return;
    })();
    return () => {
      mounted = false;
    };
  }, [loadShellData]);

  useEffect(() => {
    if (!sessionId) return;
    const eventSource = new EventSource(`/api/agent/session/${encodeURIComponent(sessionId)}/stream`);
    eventSource.addEventListener('ops.agent.history', (event: MessageEvent) => {
      const payload = JSON.parse(event.data) as { data?: { history?: AgentMessage[] } };
      if (!payload.data?.history) return;
      setSession((current) => (current ? { ...current, history: payload.data?.history ?? current.history } : current));
    });
    eventSource.addEventListener('ops.agent.status', (event: MessageEvent) => {
      const payload = JSON.parse(event.data) as { data?: { status?: string } };
      if (!payload.data?.status) return;
      setSession((current) => (current ? { ...current, status: payload.data?.status ?? current.status } : current));
    });
    return () => eventSource.close();
  }, [sessionId]);

  useEffect(() => {
    const eventSource = new EventSource('/api/events');
    eventSource.addEventListener('ops.terminal.output', (event: MessageEvent) => {
      const payload = JSON.parse(event.data) as { data?: { terminalId?: TerminalState['id']; chunk?: string } };
      const data = payload.data;
      const terminalId = data?.terminalId;
      const chunk = data?.chunk;
      if (!terminalId || !chunk) return;
      setTerminals((current) => {
        const terminal = current[terminalId];
        if (!terminal) return current;
        const buffer = [...terminal.buffer, chunk];
        if (buffer.length > 600) buffer.splice(0, buffer.length - 600);
        return { ...current, [terminal.id]: { ...terminal, buffer, lastUpdated: Date.now() } };
      });
    });
    eventSource.addEventListener('ops.terminal.status', (event: MessageEvent) => {
      const payload = JSON.parse(event.data) as { data?: { status?: TerminalState } };
      const status = payload.data?.status;
      if (!status) return;
      setTerminals((current) => ({ ...current, [status.id]: status }));
    });
    eventSource.addEventListener('ops.bridge.status', (event: MessageEvent) => {
      const payload = JSON.parse(event.data) as { data?: BridgeStatus };
      if (!payload.data) return;
      setBridge({ activeJob: payload.data.activeJob, recentJobs: payload.data.recentJobs });
    });
    eventSource.addEventListener('ops.map.updated', (event: MessageEvent) => {
      const payload = JSON.parse(event.data) as { data?: { assets?: MapAsset[]; layers?: MapLayer[]; sources?: MapSourceStatus[] } };
      if (payload.data?.assets) setAssets(payload.data.assets);
      if (payload.data?.layers) setLayers(payload.data.layers);
      if (payload.data?.sources) {
        setSourceStatuses(payload.data.sources);
      } else {
        void Promise.allSettled([opsApi.listAssets(), opsApi.listLayers(), opsApi.listSources()]).then((results) => {
          const [assetsResult, layersResult, sourcesResult] = results;
          if (assetsResult.status === 'fulfilled') setAssets(assetsResult.value.assets);
          if (layersResult.status === 'fulfilled') setLayers(layersResult.value.layers);
          if (sourcesResult.status === 'fulfilled') setSourceStatuses(sourcesResult.value.sources);
        });
      }
    });
    eventSource.addEventListener('ops.documents.updated', (event: MessageEvent) => {
      const payload = JSON.parse(event.data) as { data?: { documents?: OpsDocument[] } };
      if (payload.data?.documents) setDocuments(payload.data.documents);
    });
    return () => eventSource.close();
  }, []);

  useEffect(() => {
    chatScrollerRef.current?.scrollTo({ top: chatScrollerRef.current.scrollHeight, behavior: 'smooth' });
  }, [session?.history]);

  useEffect(() => {
    if (!selectedAsset) return;
    const refreshedSelection = assets.find((asset) => asset.id === selectedAsset.id) ?? null;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- sync selected asset when map assets refresh
    setSelectedAsset(refreshedSelection);
  }, [assets, selectedAsset]);

  const startTerminal = useCallback(
    async (terminalId: 'cli' | 'support') => {
      try {
        const response = await opsApi.startTerminal(terminalId);
        applyTerminalState(response.terminal);
        clearError();
      } catch (nextError) {
        handleError(nextError);
      }
    },
    [applyTerminalState, clearError, handleError],
  );

  const stopTerminal = useCallback(
    async (terminalId: 'cli' | 'support') => {
      try {
        const response = await opsApi.stopTerminal(terminalId);
        applyTerminalState(response.terminal);
        clearError();
      } catch (nextError) {
        handleError(nextError);
      }
    },
    [applyTerminalState, clearError, handleError],
  );

  const ctrlCTerminal = useCallback(
    async (terminalId: 'cli' | 'support') => {
      try {
        const response = await opsApi.ctrlCTerminal(terminalId);
        applyTerminalState(response.terminal);
        clearError();
      } catch (nextError) {
        handleError(nextError);
      }
    },
    [applyTerminalState, clearError, handleError],
  );

  const sendPrompt = useCallback(async () => {
    if (!prompt.trim() || sending) return;
    const gatewaySessionId = sessionId && !sessionId.startsWith('local:') ? sessionId : '';
    if (agentTransport === 'gateway' && !gatewaySessionId) return;
    if (agentTransport === 'local' && (!localApiBaseUrl.trim() || !localApiModel.trim())) {
      handleError(new Error('Select a local API model before sending.'));
      return;
    }

    const nextPrompt = prompt.trim();
    setPrompt('');
    setSending(true);
    try {
      let targetSessionId = agentTransport === 'gateway' ? gatewaySessionId : sessionId;
      if (agentTransport === 'local' && !targetSessionId?.startsWith('local:')) {
        const created = await opsApi.createSession(undefined, 'local');
        setSession(created.session);
        targetSessionId = created.session.id;
      }
      if (!targetSessionId) throw new Error('Agent session is unavailable.');

      const response = await opsApi.sendMessage(targetSessionId, nextPrompt, {
        includeDocuments: true,
        includeToolInstructions: true,
        documentIds: selectedDocumentIds,
        toolNames: selectedToolNames,
        transport: agentTransport,
        localModelId: agentTransport === 'local' ? localApiModel : undefined,
        localApiBaseUrl: agentTransport === 'local' ? localApiBaseUrl : undefined,
        localApiKey: agentTransport === 'local' ? localApiKeyInput.trim() || undefined : undefined,
      });
      setSession(response.session);
      clearError();
    } catch (nextError) {
      handleError(nextError);
    } finally {
      setSending(false);
    }
  }, [
    agentTransport,
    clearError,
    handleError,
    localApiBaseUrl,
    localApiKeyInput,
    localApiModel,
    prompt,
    selectedDocumentIds,
    selectedToolNames,
    sending,
    sessionId,
  ]);

  const handoffToCli = useCallback(async (handoffPrompt: string, handoffContext: string) => {
    if (!sessionId) {
      throw new Error('Central agent session is unavailable');
    }
    setBridgeBusyAction('handoff');
    try {
      const response = await opsApi.handoffToCli(sessionId, handoffPrompt, handoffContext);
      setBridge({ activeJob: response.activeJob, recentJobs: response.recentJobs });
      const terminalSnapshot = await opsApi.listTerminals();
      applyTerminalStates(terminalSnapshot.terminals);
      clearError();
    } catch (nextError) {
      handleError(nextError);
      throw nextError;
    } finally {
      setBridgeBusyAction(null);
    }
  }, [applyTerminalStates, clearError, handleError, sessionId]);

  const returnToAgent = useCallback(async (targetSessionId: string, text: string) => {
    setBridgeBusyAction('return');
    try {
      const response = await opsApi.returnToAgent(targetSessionId, text);
      setBridge({ activeJob: response.activeJob, recentJobs: response.recentJobs });
      clearError();
    } catch (nextError) {
      handleError(nextError);
      throw nextError;
    } finally {
      setBridgeBusyAction(null);
    }
  }, [clearError, handleError]);

  const cancelBridge = useCallback(async () => {
    setBridgeBusyAction('cancel');
    try {
      const response = await opsApi.cancelBridge();
      setBridge({ activeJob: response.activeJob, recentJobs: response.recentJobs });
      clearError();
    } catch (nextError) {
      handleError(nextError);
      throw nextError;
    } finally {
      setBridgeBusyAction(null);
    }
  }, [clearError, handleError]);

  const refreshShell = useCallback(async () => {
    await loadShellData('refresh');
  }, [loadShellData]);

  const refreshDataSources = useCallback(async () => {
    setSourceRefreshing(true);
    try {
      const response = await opsApi.refreshSources();
      setAssets(response.assets);
      setLayers(response.layers);
      setSourceStatuses(response.sources);
      clearError();
    } catch (nextError) {
      handleError(nextError);
    } finally {
      setSourceRefreshing(false);
    }
  }, [clearError, handleError]);

  const uploadDocuments = useCallback(async (fileList: FileList | File[]) => {
    const files = Array.from(fileList).filter((file) => file.size > 0);
    if (files.length === 0 || documentUploading) return;

    setDocumentUploading(true);
    try {
      let nextDocuments = documents;
      for (const file of files) {
        const response = await opsApi.uploadDocument(file, documentProject || 'General');
        nextDocuments = response.documents;
      }
      setDocuments(nextDocuments);
      clearError();
    } catch (nextError) {
      handleError(nextError);
    } finally {
      setDocumentUploading(false);
      setDocumentDragActive(false);
    }
  }, [clearError, documentProject, documentUploading, documents, handleError]);

  const deleteDocument = useCallback(async (documentId: string) => {
    try {
      const response = await opsApi.deleteDocument(documentId);
      setDocuments(response.documents);
      setSelectedDocumentIds((current) => current.filter((id) => id !== documentId));
      clearError();
    } catch (nextError) {
      handleError(nextError);
    }
  }, [clearError, handleError]);

  const toggleDocumentContext = useCallback((documentId: string) => {
    setSelectedDocumentIds((current) => (
      current.includes(documentId)
        ? current.filter((id) => id !== documentId)
        : [...current, documentId]
    ));
  }, []);

  const toggleToolFocus = useCallback((tool: AgentToolCatalogItem) => {
    setSelectedToolNames((current) => (
      current.includes(tool.id)
        ? current.filter((id) => id !== tool.id)
        : [...current, tool.id]
    ));
  }, []);

  const saveOpenAiKey = useCallback(async () => {
    if (!apiKeyInput.trim() || apiKeySaving) return;
    setApiKeySaving(true);
    try {
      const response = await opsApi.saveApiKeys({ openaiKey: apiKeyInput });
      setApiKeyStatus({
        openaiKeySet: response.openaiKeySet,
        replicateKeySet: response.replicateKeySet,
        xiaomiKeySet: response.xiaomiKeySet,
      });
      setApiKeyInput('');
      clearError();
    } catch (nextError) {
      handleError(nextError);
    } finally {
      setApiKeySaving(false);
    }
  }, [apiKeyInput, apiKeySaving, clearError, handleError]);

  const chooseAgentTransport = useCallback(async (nextTransport: AgentTransport) => {
    setAgentTransport(nextTransport);
    localStorage.setItem('ops-agent-transport', nextTransport);
    if (nextTransport === 'local' && sessionId?.startsWith('local:')) return;
    if (nextTransport === 'gateway' && sessionId && !sessionId.startsWith('local:')) return;
    try {
      const response = await opsApi.createSession(undefined, nextTransport);
      setSession(response.session);
      clearError();
    } catch (nextError) {
      handleError(nextError);
    }
  }, [clearError, handleError, sessionId]);

  const pollLocalApiModels = useCallback(async () => {
    if (!localApiBaseUrl.trim() || localApiPolling) return;
    setLocalApiPolling(true);
    try {
      const response = await opsApi.pollLocalApiModels({
        baseUrl: localApiBaseUrl,
        apiKey: localApiKeyInput.trim() || undefined,
      });
      setLocalApiModels(response.models);
      setLocalApiBaseUrl(response.baseUrl);
      if (!localApiModel && response.models[0]) {
        setLocalApiModel(response.models[0].id);
      }
      clearError();
    } catch (nextError) {
      setLocalApiModels([]);
      handleError(nextError);
    } finally {
      setLocalApiPolling(false);
    }
  }, [clearError, handleError, localApiBaseUrl, localApiKeyInput, localApiModel, localApiPolling]);

  const saveLocalApiConfig = useCallback(async () => {
    if (!localApiBaseUrl.trim() || localApiSaving) return;
    setLocalApiSaving(true);
    try {
      const response = await opsApi.saveLocalApiConfig({
        baseUrl: localApiBaseUrl,
        apiKey: localApiKeyInput.trim() || undefined,
        defaultModelId: localApiModel,
      });
      setLocalApiStatus(response.localApi);
      setLocalApiBaseUrl(response.localApi.baseUrl);
      setLocalApiModel(response.localApi.defaultModelId);
      setLocalApiKeyInput('');
      clearError();
    } catch (nextError) {
      handleError(nextError);
    } finally {
      setLocalApiSaving(false);
    }
  }, [clearError, handleError, localApiBaseUrl, localApiKeyInput, localApiModel, localApiSaving]);

  const handleMapClick = useCallback(
    (lat: number, lng: number) => {
      setClickedCoords({ lat, lng });
      clearError();
    },
    [clearError],
  );

  const filteredAssets = useMemo(
    () => assets.filter((asset) => (
      visibleFamilies[classifyAssetFamily(asset)]
      && (visibleSources[sourceKey(asset)] ?? true)
      && assetMatchesQuery(asset, mapQuery)
    )),
    [assets, mapQuery, visibleFamilies, visibleSources],
  );

  useEffect(() => {
    const selectedStillVisible = selectedAsset ? filteredAssets.some((asset) => asset.id === selectedAsset.id) : false;
    if (selectedStillVisible) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- keep the detail rail pinned to a visible asset when filters change
    setSelectedAsset(filteredAssets[0] ?? null);
  }, [filteredAssets, selectedAsset]);

  const assistantSeed = latestAssistantMessage(session?.history);
  const latestUser = latestUserMessage(session?.history);

  const runningTerminalCount = useMemo(
    () => Object.values(terminals).filter((terminal) => terminal.running).length,
    [terminals],
  );

  const familyCounts = useMemo<Record<SignalFamily, number>>(
    () => assets.reduce<Record<SignalFamily, number>>((counts, asset) => {
      counts[classifyAssetFamily(asset)] += 1;
      return counts;
    }, {
      logistics: 0,
      biological: 0,
      ordnance: 0,
      nuclear: 0,
      general: 0,
    }),
    [assets],
  );

  const sourceCounts = useMemo(
    () => assets.reduce<Record<string, number>>((counts, asset) => {
      const key = sourceKey(asset);
      counts[key] = (counts[key] ?? 0) + 1;
      return counts;
    }, {}),
    [assets],
  );

  const sourceOptions = useMemo(() => {
    const ids = Array.from(new Set(['manual', ...sourceStatuses.map((source) => source.id), ...assets.map(sourceKey)]));
    return ids.map((id) => ({
      id,
      label: sourceLabel(id, sourceStatuses),
      status: sourceStatuses.find((source) => source.id === id),
      count: sourceCounts[id] ?? 0,
    }));
  }, [assets, sourceCounts, sourceStatuses]);

  const liveSourceCount = useMemo(
    () => sourceStatuses.filter((source) => !source.catalogOnly && source.enabled && source.ok).length,
    [sourceStatuses],
  );

  const catalogSourceCount = useMemo(
    () => sourceStatuses.filter((source) => source.catalogOnly).length,
    [sourceStatuses],
  );

  const visibleMapLayerCount = useMemo(
    () => activeLayerCount(layers, filteredAssets),
    [filteredAssets, layers],
  );

  const activeThreatCount = useMemo(
    () => assets.filter((asset) => {
      const family = classifyAssetFamily(asset);
      const details = `${asset.title} ${asset.status ?? ''} ${asset.notes ?? ''}`.toLowerCase();
      return family !== 'general' || /(alert|watch|warning|anomaly|critical|threat)/.test(details);
    }).length,
    [assets],
  );

  const reportCount = useMemo(
    () => assets.filter((asset) => asset.type === 'document' || asset.type === 'note').length,
    [assets],
  );

  const analyticsCount = useMemo(
    () => assets.filter((asset) => asset.type === 'video' || asset.type === 'link').length + bridge.recentJobs.length,
    [assets, bridge.recentJobs],
  );

  const operationalPosture = useMemo(() => {
    if (error) {
      return {
        label: 'Attention Required',
        tone: 'warning',
        detail: error,
      };
    }
    if (bridge.activeJob) {
      return {
        label: 'Bridge Active',
        tone: 'active',
        detail: `CLI handoff ${bridge.activeJob.state}. Session ${bridge.activeJob.sessionId} is in motion.`,
      };
    }
    if (activeThreatCount > 0) {
      return {
        label: 'Monitoring',
        tone: 'watch',
        detail: `${activeThreatCount} tracked signals are currently under watch across the network.`,
      };
    }
    return {
      label: 'Nominal',
      tone: 'nominal',
      detail: 'All systems stable. No immediate threats detected.',
    };
  }, [activeThreatCount, bridge.activeJob, error]);

  const readinessScore = useMemo(() => {
    const score = 58
      + Math.min(activeLayerCount(layers), 5) * 5
      + Math.min(assets.length, 6) * 3
      + Math.min(liveSourceCount, 5) * 2
      + runningTerminalCount * 4
      - (bridge.activeJob ? 8 : 0)
      - (error ? 18 : 0);
    return Math.max(32, Math.min(94, score));
  }, [assets.length, bridge.activeJob, error, layers, liveSourceCount, runningTerminalCount]);

  const familySummaryCards = useMemo(
    () => [
      { key: 'ordnance', label: 'Ordnance', count: familyCounts.ordnance, note: 'Alerts under review' },
      { key: 'biological', label: 'Biological', count: familyCounts.biological, note: 'Signals being monitored' },
      { key: 'general', label: 'Intelligence', count: familyCounts.general + assets.filter((asset) => asset.type === 'link').length, note: 'Cross-source watch' },
      { key: 'nuclear', label: 'Nuclear', count: familyCounts.nuclear, note: 'Alerts currently tagged' },
    ],
    [assets, familyCounts],
  );

  const briefingItems = useMemo(
    () => [
      {
        id: 'threats',
        label: 'Threat Picture',
        title: activeThreatCount ? `${activeThreatCount} monitored signals` : 'No active threats',
        detail: activeThreatCount
          ? `${familyCounts.ordnance} ordnance, ${familyCounts.biological} bio, ${familyCounts.nuclear} nuclear.`
          : 'Coverage is clear across tagged threat families.',
      },
      {
        id: 'logistics',
        label: 'Logistics',
        title: familyCounts.logistics ? `${familyCounts.logistics} logistics-linked items` : 'No logistics markers',
        detail: familyCounts.logistics
          ? 'Route, cargo, or shipping activity is represented in the current map assets.'
          : 'Awaiting logistics-linked documents, links, or feeds.',
      },
      {
        id: 'analytics',
        label: 'Analytics',
        title: `${analyticsCount} analytics signals`,
        detail: `${layers.length} map layers visible and ${bridge.recentJobs.length} bridge jobs tracked.`,
      },
      {
        id: 'reports',
        label: 'Reports',
        title: `${reportCount} report assets`,
        detail: reportCount
          ? 'Documents and notes are ready for review in the document center.'
          : 'No reports have been linked into the map store yet.',
      },
    ],
    [activeThreatCount, analyticsCount, bridge.recentJobs.length, familyCounts, layers.length, reportCount],
  );

  const statusCards = useMemo(
    () => [
      {
        id: 'map',
        label: 'Threats',
        value: activeThreatCount,
        detail: activeThreatCount
          ? `${familyCounts.ordnance + familyCounts.biological + familyCounts.nuclear} family-tagged signals require watch.`
          : 'No threat-tagged signals currently in the queue.',
        icon: <AlertTriangle size={16} />,
      },
      {
        id: 'analytics',
        label: 'Analytics',
        value: analyticsCount,
        detail: `${layers.length} map layers plus ${bridge.recentJobs.length} bridge handoff records are available.`,
        icon: <BarChart3 size={16} />,
      },
      {
        id: 'logistics',
        label: 'Logistics',
        value: familyCounts.logistics,
        detail: familyCounts.logistics
          ? 'Movement-linked assets are represented in the operational picture.'
          : 'No logistics-linked assets have been tagged yet.',
        icon: <Folder size={16} />,
      },
      {
        id: 'sources',
        label: 'Sources',
        value: liveSourceCount,
        detail: `${sourceStatuses.length || 10} configured sources; ${assets.filter((asset) => asset.live).length} live points loaded.`,
        icon: <Satellite size={16} />,
      },
      {
        id: 'reports',
        label: 'Reports',
        value: reportCount,
        detail: reportCount
          ? 'Reports and notes are available for operator review.'
          : 'No document or note assets are attached yet.',
        icon: <FileText size={16} />,
      },
    ],
    [
      activeThreatCount,
      analyticsCount,
      assets,
      bridge.recentJobs.length,
      familyCounts.biological,
      familyCounts.logistics,
      familyCounts.nuclear,
      familyCounts.ordnance,
      layers.length,
      liveSourceCount,
      reportCount,
      sourceStatuses.length,
    ],
  );

  const messageFeed = useMemo(
    () => session?.history.filter((message) => message.role === 'assistant' || message.role === 'user').slice(-4) ?? [],
    [session?.history],
  );

  const documentCenterAssets = useMemo(() => {
    const ordered = selectedAsset
      ? [selectedAsset, ...filteredAssets.filter((asset) => asset.id !== selectedAsset.id)]
      : filteredAssets;
    return ordered.slice(0, 4);
  }, [filteredAssets, selectedAsset]);

  const documentGroups = useMemo(() => groupDocumentsByProject(documents), [documents]);
  const toolGroups = useMemo(() => groupToolsByCategory(toolCatalog?.tools ?? []), [toolCatalog]);
  const localModelOptions = useMemo(() => {
    const byId = new Map<string, LocalApiModel>();
    for (const model of localApiModels) byId.set(model.id, model);
    if (localApiModel && !byId.has(localApiModel)) byId.set(localApiModel, { id: localApiModel });
    return Array.from(byId.values()).sort((left, right) => left.id.localeCompare(right.id));
  }, [localApiModel, localApiModels]);
  const selectedDocuments = useMemo(
    () => documents.filter((document) => selectedDocumentIds.includes(document.id)),
    [documents, selectedDocumentIds],
  );
  const agentSendDisabled = sending
    || !prompt.trim()
    || (agentTransport === 'gateway' && (!sessionId || sessionId.startsWith('local:')))
    || (agentTransport === 'local' && (!localApiBaseUrl.trim() || !localApiModel.trim()));
  const agentChatFeed = useMemo(
    () => session?.history.filter((message) => message.role !== 'system').slice(-80) ?? [],
    [session?.history],
  );

  function renderAgentTrace(reasoning: string[], toolCalls: AgentToolCall[]) {
    const reasoningItems = reasoningToTraceItems(reasoning);
    const toolItems = toolCallsToTraceItems(toolCalls);
    if (!reasoningItems.length && !toolItems.length) return null;

    return (
      <div className="ops-agent-trace-stack">
        {reasoningItems.length ? (
          <details className="ops-agent-trace-panel">
            <summary>
              <Brain size={14} />
              Reasoning trace
              <span>{reasoningItems.length}</span>
            </summary>
            <AnimatedTraceList items={reasoningItems} className="ops-agent-trace-list reasoning" />
          </details>
        ) : null}
        {toolItems.length ? (
          <details className="ops-agent-trace-panel tool">
            <summary>
              <Wrench size={14} />
              Tool calls
              <span>{toolItems.length}</span>
            </summary>
            <AnimatedTraceList items={toolItems} className="ops-agent-trace-list tool" />
          </details>
        ) : null}
      </div>
    );
  }

  function renderAgentChatMessage(message: AgentMessage) {
    const inline = splitInlineReasoning(message.text);
    const reasoning = Array.from(new Set([...(message.reasoning ?? []), ...inline.reasoning]));
    const toolCalls = message.role === 'tool'
      ? (message.toolCalls?.length ? message.toolCalls : [{ type: 'tool', name: 'Tool result', arguments: message.text }])
      : (message.toolCalls ?? []);
    const visibleText = inline.reply || (message.role === 'assistant' && reasoning.length ? 'Reasoning trace received without final answer.' : message.text);

    return (
      <article key={message.id} className="ops-agent-message" data-role={message.role}>
        <div className="ops-agent-message-head">
          <strong>{message.role === 'assistant' ? 'ROBIN' : message.role === 'tool' ? 'Tool' : 'Operator'}</strong>
          <time>{formatClock(message.createdAt)}</time>
        </div>
        {message.role === 'assistant' ? (
          <TextType key={message.id} text={visibleText} as="div" className="ops-agent-message-text" />
        ) : message.role === 'tool' ? null : (
          <div className="ops-agent-message-text">{visibleText}</div>
        )}
        {renderAgentTrace(reasoning, toolCalls)}
      </article>
    );
  }

  return (
    <div className="ops-app">
      <div className="ops-command-shell">
        <header className="ops-header">
          <div className="ops-brand-panel">
            <img src="/branding/ROBIN_brand.png" alt="ROBIN brand mark" className="ops-logo" />
            <div className="ops-brand-copy">
              <div className="ops-brand-title">ROBIN</div>
              <div className="ops-brand-subtitle">Threat Detection</div>
              <p>Rare ordnance, biological, intelligence, and nuclear watch.</p>
            </div>
          </div>

          <div className="ops-nav-panel">
            <nav className="ops-tabs" aria-label="Primary">
              <button
                className={`ops-tab ${activeTab === 'map' ? 'active' : ''}`}
                onClick={() => setActiveTab('map')}
                type="button"
              >
                <MapPinned size={16} /> Map Overview
              </button>
              <button
                className={`ops-tab ${activeTab === 'status' ? 'active' : ''}`}
                onClick={() => setActiveTab('status')}
                type="button"
              >
                <Activity size={16} /> Status Overview
              </button>
              <button
                className={`ops-tab ${activeTab === 'agent' ? 'active' : ''}`}
                onClick={() => setActiveTab('agent')}
                type="button"
              >
                <Code2 size={16} /> Agent
              </button>
            </nav>

            <div className="ops-header-actions">
              <button onClick={() => { void refreshShell(); }} className="ops-button ghost" type="button">
                <RefreshCw size={16} /> Refresh
              </button>
              <button onClick={() => { void onLogout(); }} className="ops-button ghost" type="button">
                <LogOut size={16} /> Logout
              </button>
            </div>
          </div>
        </header>

        {error && (
          <div className="ops-error-banner">
            <CornerDownLeft size={16} /> {error}
            <button onClick={clearError} className="ops-button ghost" type="button">
              Dismiss
            </button>
          </div>
        )}

        {loading && (
          <div className="ops-loading">
            <LoaderCircle className="spinning" size={32} />
            <p>Initializing ROBIN command surface...</p>
          </div>
        )}

        {!loading && (
          <main className="ops-main">
            {activeTab === 'map' && (
              <section className="ops-map-overview">
                <aside className="ops-map-rail ops-map-rail-left">
                  <div className="ops-rail-card ops-system-card" data-tone={operationalPosture.tone}>
                    <div className="ops-section-kicker">System Status</div>
                    <div className="ops-system-head">
                      <strong>{operationalPosture.label}</strong>
                      <span className="ops-status-ring">{readinessScore}%</span>
                    </div>
                    <p>{operationalPosture.detail}</p>
                    <div className="ops-operator-meta">
                      <span><ShieldCheck size={14} /> Session {session?.label ?? 'offline'}</span>
                      <span><RadioTower size={14} /> {runningTerminalCount}/3 terminals live</span>
                    </div>
                  </div>

                  <div className="ops-rail-card">
                    <div className="ops-rail-switcher">
                      <button
                        type="button"
                        className={`ops-rail-switch ${railMode === 'chat' ? 'active' : ''}`}
                        onClick={() => setRailMode('chat')}
                      >
                        Chat
                      </button>
                      <button
                        type="button"
                        className={`ops-rail-switch ${railMode === 'briefings' ? 'active' : ''}`}
                        onClick={() => setRailMode('briefings')}
                      >
                        Briefings
                      </button>
                    </div>

                    {railMode === 'chat' ? (
                      <div className="ops-chat-feed" ref={chatScrollerRef}>
                        {messageFeed.length === 0 ? (
                          <div className="ops-helper">No session traffic yet. Send a prompt to start the operator log.</div>
                        ) : (
                          messageFeed.map((message) => (
                            <article
                              key={message.id}
                              className={`ops-chat-card ops-chat-card-${message.role}`}
                            >
                              <div className="ops-chat-card-head">
                                <strong>{message.role === 'assistant' ? 'ROBIN Assistant' : 'You'}</strong>
                                <time>{formatClock(message.createdAt)}</time>
                              </div>
                              <div className="ops-chat-card-body">
                                {message.role === 'assistant' ? <FuzzyText>{message.text}</FuzzyText> : message.text}
                              </div>
                            </article>
                          ))
                        )}
                      </div>
                    ) : (
                      <div className="ops-briefing-list">
                        {briefingItems.map((item) => (
                          <article key={item.id} className="ops-briefing-card">
                            <span className="ops-section-kicker">{item.label}</span>
                            <strong>{item.title}</strong>
                            <p>{item.detail}</p>
                          </article>
                        ))}
                      </div>
                    )}
                  </div>

                  <div className="ops-rail-card ops-source-card">
                    <div className="ops-source-card-head">
                      <div>
                        <div className="ops-section-kicker">Data Sources</div>
                        <strong>{liveSourceCount} live feeds · {catalogSourceCount} reference sources</strong>
                      </div>
                      <button
                        type="button"
                        className="ops-button ghost"
                        onClick={() => { void refreshDataSources(); }}
                        disabled={sourceRefreshing}
                        title="Refresh geo data sources"
                      >
                        {sourceRefreshing ? <LoaderCircle className="spinning" size={16} /> : <RefreshCw size={16} />}
                      </button>
                    </div>
                    <div className="ops-source-list">
                      {sourceOptions.map((source) => (
                        <button
                          key={source.id}
                          type="button"
                          className="ops-source-toggle"
                          data-active={visibleSources[source.id] ?? true}
                          data-tone={sourceStatusTone(source.status)}
                          onClick={() => {
                            setVisibleSources((current) => ({
                              ...current,
                              [source.id]: !(current[source.id] ?? true),
                            }));
                          }}
                          title={source.status?.lastError || source.status?.description || source.status?.attribution || source.label}
                        >
                          <span className="ops-layer-label">
                            {sourceIcon(source.id)}
                            <span className="ops-source-copy">
                              <strong>{source.label}</strong>
                              {source.status?.description ? <small>{source.status.description}</small> : null}
                            </span>
                          </span>
                          <span className="ops-source-meta">
                            <span>{source.count}</span>
                            {source.status?.requiresKey && !source.status.enabled ? <span>key</span> : null}
                            {source.status?.catalogOnly ? <span>ref</span> : null}
                          </span>
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="ops-rail-card ops-compose-card">
                    <div className="ops-section-kicker">Command Deck</div>
                    <textarea
                      value={prompt}
                      onChange={(event) => setPrompt(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' && !event.shiftKey) {
                          event.preventDefault();
                          void sendPrompt();
                        }
                      }}
                      placeholder="Ask ROBIN anything..."
                      className="ops-chat-textarea ops-chat-textarea-compact"
                      disabled={sending || !sessionId}
                    />
                    <div className="ops-compose-footer">
                      <span>{latestUser ? `Last operator prompt ${formatRelative(session?.updatedAt)}` : 'No operator prompt yet'}</span>
                      <button
                        onClick={sendPrompt}
                        disabled={sending || !prompt.trim() || !sessionId}
                        className="ops-button primary"
                        type="button"
                      >
                        {sending ? <LoaderCircle className="spinning" size={16} /> : <Send size={16} />}
                        {sending ? 'Sending...' : 'Send'}
                      </button>
                    </div>
                  </div>
                </aside>

                <div className="ops-map-stage">
                  <div className="ops-stage-head">
                    <div>
                      <div className="ops-section-kicker">Map Overview</div>
                      <h2>Geo-linked signal picture</h2>
                    </div>
                    <div className="ops-stage-meta">
                      Showing {filteredAssets.length} assets across {Object.values(visibleFamilies).filter(Boolean).length}/
                      {SIGNAL_FAMILIES.length} signal families and {Object.values(visibleSources).filter(Boolean).length} data sources.
                      {clickedCoords ? (
                        <span> Last click {clickedCoords.lat.toFixed(3)}, {clickedCoords.lng.toFixed(3)}</span>
                      ) : null}
                    </div>
                  </div>

                  <div className="ops-map-shell">
                    <div className="ops-map-toolbar">
                      <input
                        className="ops-input"
                        value={mapQuery}
                        onChange={(event) => setMapQuery(event.target.value)}
                        placeholder="Filter signals by title, notes, tags, or source..."
                      />
                      <span className="ops-mini-badge">
                        <Layers3 size={14} /> {visibleMapLayerCount} visible map layers
                      </span>
                      <span className="ops-mini-badge">
                        <DatabaseZap size={14} /> {assets.filter((asset) => asset.live).length} live source points
                      </span>
                    </div>

                    <LeafletMap
                      assets={filteredAssets}
                      selectedAssetId={selectedAsset?.id ?? null}
                      onSelectAsset={setSelectedAsset}
                      onMapClick={handleMapClick}
                    />

                    <div className="ops-floating-card ops-floating-layers">
                      <div className="ops-floating-head">
                        <Layers3 size={14} /> Signal Families
                      </div>
                      <div className="ops-floating-body">
                        {SIGNAL_FAMILIES.map((family) => (
                          <button
                            key={family.id}
                            type="button"
                            className="ops-layer-toggle"
                            data-active={visibleFamilies[family.id]}
                            onClick={() => {
                              setVisibleFamilies((current) => ({
                                ...current,
                                [family.id]: !current[family.id],
                              }));
                            }}
                          >
                            <span className="ops-layer-label">
                              {familyIcon(family.id)}
                              {family.label}
                            </span>
                            <span className="ops-layer-count">{familyCounts[family.id]}</span>
                          </button>
                        ))}
                      </div>
                    </div>

                    <div className="ops-map-center-mark" aria-hidden="true">
                      <div className="ops-map-center-logo">
                        <img src="/branding/ROBIN_brand.png" alt="" />
                      </div>
                      <div className="ops-map-center-copy">
                        <strong>ROBIN</strong>
                        <span>Rare ordnance, biological, intelligence, and nuclear detection</span>
                      </div>
                    </div>

                    <div className="ops-map-summary-strip">
                      {familySummaryCards.map((card) => (
                        <article key={card.key} className="ops-summary-card">
                          <span>{card.label}</span>
                          <strong>{card.count}</strong>
                          <small>{card.note}</small>
                        </article>
                      ))}
                      <div className="ops-summary-progress">
                        <div className="ops-summary-progress-head">
                          <span>Operational Posture</span>
                          <strong>{readinessScore}%</strong>
                        </div>
                        <div className="ops-summary-bar">
                          <div className="ops-summary-bar-fill" style={{ width: `${readinessScore}%` }} />
                        </div>
                        <small>{bridge.activeJob ? 'Bridge in motion' : 'Stable posture'}</small>
                      </div>
                    </div>
                  </div>
                </div>

                <aside className="ops-map-rail ops-map-rail-right">
                  <div className="ops-detail-card">
                    <div className="ops-panel-header">
                      <h3>{selectedAsset ? selectedAsset.title : 'Selected Signal'}</h3>
                      <span className="ops-mini-badge">
                        {selectedAsset ? familyLabel(classifyAssetFamily(selectedAsset)) : operationalPosture.label}
                      </span>
                    </div>
                    <div className="ops-panel-body">
                      <MapAssetInspector asset={selectedAsset} currentSessionId={sessionId} />
                    </div>
                  </div>

                  <div className="ops-detail-card">
                    <div className="ops-panel-header">
                      <h3>Document Center</h3>
                      <span className="ops-mini-badge">{documentCenterAssets.length} linked items</span>
                    </div>
                    <div className="ops-panel-body">
                      {documentCenterAssets.length === 0 ? (
                        <div className="ops-helper">
                          No linked documents or feeds yet. Once assets are added, they will appear here for quick drill-in.
                        </div>
                      ) : (
                        <div className="ops-document-list">
                          {documentCenterAssets.map((asset) => (
                            <button
                              key={asset.id}
                              type="button"
                              className="ops-document-card"
                              onClick={() => setSelectedAsset(asset)}
                            >
                              <span className="ops-document-card-icon">{familyIcon(classifyAssetFamily(asset))}</span>
                              <span className="ops-document-card-copy">
                                <strong>{asset.title}</strong>
                                <small>
                                  {familyLabel(classifyAssetFamily(asset))} · {asset.status || asset.type}
                                </small>
                              </span>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                </aside>
              </section>
            )}

            {activeTab === 'status' && (
              <section className="ops-status-overview">
                <div className="ops-panel ops-status-hero">
                  <div className="ops-panel-body ops-status-hero-body">
                    <div className="ops-status-hero-copy">
                      <div className="ops-section-kicker">Status Overview</div>
                      <h2>{operationalPosture.label}</h2>
                      <p>{operationalPosture.detail}</p>
                      <div className="ops-status-inline">
                        <span className="ops-mini-badge">
                          <Bot size={14} /> {session?.label ?? 'Session offline'}
                        </span>
                        <span className="ops-mini-badge">
                          <Layers3 size={14} /> {assets.length} tracked assets
                        </span>
                        <span className="ops-mini-badge">
                          <DatabaseZap size={14} /> {liveSourceCount} source feeds
                        </span>
                        <span className="ops-mini-badge">
                          <TerminalSquare size={14} /> {runningTerminalCount}/3 terminals live
                        </span>
                      </div>
                    </div>

                    <div className="ops-status-kpis">
                      <div className="ops-kpi-card">
                        <span>Bridge Jobs</span>
                        <strong>{bridge.recentJobs.length}</strong>
                        <small>{bridge.activeJob ? bridge.activeJob.state : 'idle'}</small>
                      </div>
                      <div className="ops-kpi-card">
                        <span>Active Layers</span>
                        <strong>{activeLayerCount(layers)}</strong>
                        <small>{layers.length} total</small>
                      </div>
                      <div className="ops-kpi-card">
                        <span>Reports Ready</span>
                        <strong>{reportCount}</strong>
                        <small>docs and notes</small>
                      </div>
                    </div>
                  </div>
                </div>

                <div className="ops-status-grid">
                  {statusCards.map((card) => (
                    <article key={card.id} className="ops-status-card">
                      <div className="ops-status-card-head">
                        <span>{card.icon}{card.label}</span>
                        <strong>{card.value}</strong>
                      </div>
                      <p>{card.detail}</p>
                    </article>
                  ))}
                </div>

                <div className="ops-panel ops-documents-panel">
                  <div className="ops-panel-header">
                    <h3>Documents</h3>
                    <span className="ops-mini-badge">{documents.length} uploaded docs</span>
                  </div>
                  <div className="ops-panel-body ops-documents-body">
                    <div
                      className="ops-upload-drop"
                      data-active={documentDragActive}
                      onDragOver={(event) => {
                        event.preventDefault();
                        setDocumentDragActive(true);
                      }}
                      onDragLeave={() => setDocumentDragActive(false)}
                      onDrop={(event) => {
                        event.preventDefault();
                        void uploadDocuments(event.dataTransfer.files);
                      }}
                    >
                      <div className="ops-upload-copy">
                        <FileUp size={22} />
                        <div>
                          <strong>Drop documents here</strong>
                          <span>Text, markdown, CSV, JSON, PDF, Word, and reference files.</span>
                        </div>
                      </div>
                      <div className="ops-upload-controls">
                        <input
                          className="ops-input"
                          value={documentProject}
                          onChange={(event) => setDocumentProject(event.target.value)}
                          placeholder="Project"
                        />
                        <label className="ops-button primary ops-file-picker">
                          <Upload size={16} />
                          {documentUploading ? 'Uploading...' : 'Upload'}
                          <input
                            type="file"
                            multiple
                            accept=".txt,.md,.markdown,.pdf,.doc,.docx,.rtf,.csv,.tsv,.json,.jsonl,.yaml,.yml,.xml,.html,.htm,.log"
                            onChange={(event) => {
                              const files = event.currentTarget.files;
                              if (files) void uploadDocuments(files);
                              event.currentTarget.value = '';
                            }}
                            disabled={documentUploading}
                          />
                        </label>
                      </div>
                    </div>

                    <div className="ops-document-groups">
                      {documentGroups.length === 0 ? (
                        <div className="ops-helper">No project documents uploaded yet.</div>
                      ) : (
                        documentGroups.map((group) => (
                          <details key={group.project} className="ops-document-project" open>
                            <summary>
                              <ChevronRight size={15} />
                              <strong>{group.project}</strong>
                              <span>{group.documents.length}</span>
                            </summary>
                            <div className="ops-document-table">
                              {group.documents.map((document) => {
                                const selected = selectedDocumentIds.includes(document.id);
                                return (
                                  <div key={document.id} className="ops-document-row" data-selected={selected}>
                                    <button
                                      type="button"
                                      className="ops-document-ref"
                                      onClick={() => toggleDocumentContext(document.id)}
                                      title={selected ? 'Remove from agent context' : 'Add to agent context'}
                                    >
                                      <Paperclip size={14} />
                                    </button>
                                    <div className="ops-document-row-main">
                                      <strong>{document.title}</strong>
                                      <small>
                                        {document.kind.toUpperCase()} · {formatBytes(document.sizeBytes)} · {formatRelative(document.uploadedAt)} · {document.id}
                                      </small>
                                    </div>
                                    <a className="ops-document-path" href={document.sourceUrl} download title={document.storagePath}>
                                      {document.fileName}
                                    </a>
                                    <button
                                      type="button"
                                      className="ops-icon-button"
                                      onClick={() => { void deleteDocument(document.id); }}
                                      title="Delete document"
                                    >
                                      <Trash2 size={14} />
                                    </button>
                                  </div>
                                );
                              })}
                            </div>
                          </details>
                        ))
                      )}
                    </div>
                  </div>
                </div>

                <div className="ops-status-columns">
                  <div className="ops-panel">
                    <div className="ops-panel-header">
                      <h3>Recent Activity</h3>
                      <span className="ops-mini-badge">{messageFeed.length} recent entries</span>
                    </div>
                    <div className="ops-panel-body">
                      <div className="ops-activity-list">
                        {messageFeed.length === 0 ? (
                          <div className="ops-helper">No operator activity has been recorded yet.</div>
                        ) : (
                          messageFeed.map((message) => (
                            <article key={message.id} className="ops-activity-card">
                              <div className="ops-chat-card-head">
                                <strong>{message.role === 'assistant' ? 'ROBIN Assistant' : 'Operator'}</strong>
                                <time>{formatClock(message.createdAt)}</time>
                              </div>
                              <p>{message.text}</p>
                            </article>
                          ))
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="ops-panel">
                    <div className="ops-panel-header">
                      <h3>Bridge and Layer Posture</h3>
                      <span className="ops-mini-badge">{bridge.activeJob ? 'Active' : 'Idle'}</span>
                    </div>
                    <div className="ops-panel-body ops-sidebar-stack">
                      <div className="ops-note">
                        {bridge.activeJob
                          ? `Bridge job ${bridge.activeJob.id} is ${bridge.activeJob.state} for session ${bridge.activeJob.sessionId}.`
                          : 'No active CLI bridge job. Operator handoffs are clear.'}
                      </div>
                      <div className="ops-list">
                        {layers.length === 0 ? (
                          <div className="ops-helper">The backend has not reported any map layers yet.</div>
                        ) : (
                          layers.map((layer) => (
                            <div key={layer.id} className="ops-list-card" data-active={layer.visible}>
                              <strong>{layer.name}</strong>
                              <small>{layer.visible ? 'Visible' : 'Hidden'} · {layer.assetIds.length} linked assets</small>
                            </div>
                          ))
                        )}
                      </div>
                    </div>
                  </div>
                </div>

                <div className="ops-status-columns">
                  <div className="ops-panel">
                    <div className="ops-panel-header">
                      <h3>Signal Families</h3>
                      <span className="ops-mini-badge">{assets.length} assets total</span>
                    </div>
                    <div className="ops-panel-body">
                      <div className="ops-family-grid">
                        {SIGNAL_FAMILIES.map((family) => (
                          <article key={family.id} className="ops-family-card">
                            <div className="ops-family-card-head">
                              <span>{familyIcon(family.id)} {family.label}</span>
                              <strong>{familyCounts[family.id]}</strong>
                            </div>
                            <p>{family.description}</p>
                          </article>
                        ))}
                      </div>
                    </div>
                  </div>

                  <div className="ops-panel">
                    <div className="ops-panel-header">
                      <h3>Operator Snapshot</h3>
                      <span className="ops-mini-badge">{formatRelative(session?.updatedAt)}</span>
                    </div>
                    <div className="ops-panel-body ops-sidebar-stack">
                      <div className="ops-note">
                        {assistantSeed || 'No assistant response has been recorded in the current session yet.'}
                      </div>
                      <div className="ops-note">
                        {latestUser || 'No operator prompt has been submitted in the current session yet.'}
                      </div>
                    </div>
                  </div>
                </div>
              </section>
            )}

            {activeTab === 'agent' && (
              <section className="ops-agent-layout">
                <div className="ops-panel">
                  <div className="ops-panel-body">
                    <div className="ops-terminal-topbar">
                      <div>
                        <div className="ops-section-kicker">Agent Workspace</div>
                        <h2>Chat lane with document and tool context</h2>
                        <p className="ops-terminal-topbar-copy">
                          Messages can run through the gateway session or a local OpenAI-compatible API with uploaded documents and mapped Claude Code tool instructions attached as context.
                        </p>
                      </div>
                      <div className="ops-agent-kpis">
                        <span className="ops-mini-badge"><Bot size={14} /> {agentTransport === 'local' ? 'Local API' : session?.label ?? 'No session'}</span>
                        <span className="ops-mini-badge"><Code2 size={14} /> {agentTransport === 'local' ? localApiModel || 'No local model' : 'Gateway'}</span>
                        <span className="ops-mini-badge"><Paperclip size={14} /> {selectedDocuments.length || documents.length} docs</span>
                        <span className="ops-mini-badge"><Wrench size={14} /> {toolCatalog?.tools.length ?? 0} tools</span>
                      </div>
                    </div>
                  </div>
                </div>

                <div className="ops-agent-chat-layout">
                  <div className="ops-panel ops-agent-chat-panel">
                    <div className="ops-panel-header">
                      <h2>ROBIN Agent Chat</h2>
                      <div className="ops-action-row">
                        <span className="ops-mini-badge">{session?.status ?? 'offline'}</span>
                        <button className="ops-button ghost" onClick={() => { void refreshShell(); }} type="button">
                          <RefreshCw size={16} /> Refresh
                        </button>
                      </div>
                    </div>
                    <div className="ops-panel-body ops-agent-chat-body">
                      <div className="ops-agent-chat-log" ref={chatScrollerRef}>
                        {agentChatFeed.length === 0 ? (
                          <div className="ops-agent-empty">
                            <Bot size={22} />
                            <span>No agent messages yet.</span>
                          </div>
                        ) : (
                          agentChatFeed.map((message) => renderAgentChatMessage(message))
                        )}
                      </div>

                      {selectedDocuments.length > 0 ? (
                        <div className="ops-agent-context-strip">
                          {selectedDocuments.map((document) => (
                            <button
                              key={document.id}
                              type="button"
                              onClick={() => toggleDocumentContext(document.id)}
                              title={document.storagePath}
                            >
                              <Paperclip size={13} /> {document.title}
                            </button>
                          ))}
                        </div>
                      ) : null}

                      <form
                        className="ops-agent-compose"
                        onSubmit={(event) => {
                          event.preventDefault();
                          void sendPrompt();
                        }}
                      >
                        <textarea
                          value={prompt}
                          onChange={(event) => setPrompt(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter' && !event.shiftKey) {
                              event.preventDefault();
                              void sendPrompt();
                            }
                          }}
                          placeholder="Ask the agent to inspect documents, use a mapped tool, or brief the current project..."
                          className="ops-chat-textarea ops-agent-textarea"
                          disabled={sending || (agentTransport === 'gateway' && (!sessionId || sessionId.startsWith('local:')))}
                        />
                        <div className="ops-compose-footer">
                          <span>
                            {agentTransport === 'local' ? 'Local API' : 'Gateway'} · {documents.length} docs and {toolCatalog?.tools.length ?? 0} tools are included as agent context.
                          </span>
                          <button
                            onClick={sendPrompt}
                            disabled={agentSendDisabled}
                            className="ops-button primary"
                            type="button"
                          >
                            {sending ? <LoaderCircle className="spinning" size={16} /> : <Send size={16} />}
                            {sending ? 'Sending...' : 'Send'}
                          </button>
                        </div>
                      </form>
                    </div>
                  </div>

                  <aside className="ops-agent-sidebar">
                    <div className="ops-panel">
                      <div className="ops-panel-header">
                        <h3>Quick API Setup</h3>
                        <span className="ops-mini-badge">
                          <KeyRound size={14} /> {agentTransport === 'local' ? localApiStatus?.apiKeySet ? 'Local key set' : 'Local key optional' : apiKeyStatus?.openaiKeySet ? 'OpenAI set' : 'OpenAI missing'}
                        </span>
                      </div>
                      <div className="ops-panel-body ops-sidebar-stack">
                        <div className="ops-segmented-control">
                          <button
                            type="button"
                            data-active={agentTransport === 'gateway'}
                            onClick={() => { void chooseAgentTransport('gateway'); }}
                          >
                            Gateway
                          </button>
                          <button
                            type="button"
                            data-active={agentTransport === 'local'}
                            onClick={() => { void chooseAgentTransport('local'); }}
                          >
                            Local API
                          </button>
                        </div>

                        <div className="ops-local-api-grid">
                          <label>
                            <span>Local IP / endpoint</span>
                            <input
                              className="ops-input"
                              value={localApiBaseUrl}
                              onChange={(event) => setLocalApiBaseUrl(event.target.value)}
                              onBlur={() => { if (agentTransport === 'local') void pollLocalApiModels(); }}
                              placeholder="127.0.0.1:1234"
                            />
                          </label>
                          <label>
                            <span>LM Studio API key</span>
                            <input
                              className="ops-input"
                              type="password"
                              value={localApiKeyInput}
                              onChange={(event) => setLocalApiKeyInput(event.target.value)}
                              placeholder={localApiStatus?.apiKeySet ? 'Saved key set' : 'lm-studio'}
                            />
                          </label>
                        </div>

                        <label className="ops-local-model-field">
                          <span>Local model</span>
                          <div className="ops-model-select-row">
                            <select
                              className="ops-input ops-select"
                              value={localApiModel}
                              onFocus={() => { void pollLocalApiModels(); }}
                              onChange={(event) => setLocalApiModel(event.target.value)}
                            >
                              {!localApiModel && <option value="">Poll models...</option>}
                              {localModelOptions.map((model) => (
                                <option key={model.id} value={model.id}>
                                  {model.name || model.id}
                                </option>
                              ))}
                            </select>
                            <button
                              type="button"
                              className="ops-button ghost"
                              onClick={() => { void pollLocalApiModels(); }}
                              disabled={localApiPolling}
                            >
                              {localApiPolling ? <LoaderCircle className="spinning" size={14} /> : <RefreshCw size={14} />}
                              Poll
                            </button>
                          </div>
                        </label>

                        <button
                          type="button"
                          className="ops-button primary"
                          disabled={!localApiBaseUrl.trim() || localApiSaving}
                          onClick={saveLocalApiConfig}
                        >
                          {localApiSaving ? <LoaderCircle className="spinning" size={16} /> : <KeyRound size={16} />}
                          {localApiSaving ? 'Saving...' : 'Save local wire'}
                        </button>

                        <input
                          className="ops-input"
                          type="password"
                          value={apiKeyInput}
                          onChange={(event) => setApiKeyInput(event.target.value)}
                          placeholder="Paste OPENAI_API_KEY"
                        />
                        <button
                          type="button"
                          className="ops-button primary"
                          disabled={!apiKeyInput.trim() || apiKeySaving}
                          onClick={saveOpenAiKey}
                        >
                          {apiKeySaving ? <LoaderCircle className="spinning" size={16} /> : <KeyRound size={16} />}
                          {apiKeySaving ? 'Saving...' : 'Save key'}
                        </button>
                      </div>
                    </div>

                    <div className="ops-panel">
                      <div className="ops-panel-header">
                        <h3>Project Documents</h3>
                        <span className="ops-mini-badge">{selectedDocumentIds.length || 'all'} in context</span>
                      </div>
                      <div className="ops-panel-body ops-agent-doc-list">
                        {documentGroups.length === 0 ? (
                          <div className="ops-helper">Upload documents from Status Overview.</div>
                        ) : (
                          documentGroups.map((group) => (
                            <details key={group.project} className="ops-agent-side-details" open>
                              <summary>
                                <ChevronRight size={14} />
                                {group.project}
                                <span>{group.documents.length}</span>
                              </summary>
                              {group.documents.map((document) => (
                                <button
                                  key={document.id}
                                  type="button"
                                  className="ops-agent-doc-button"
                                  data-selected={selectedDocumentIds.includes(document.id)}
                                  onClick={() => toggleDocumentContext(document.id)}
                                  title={document.storagePath}
                                >
                                  <FileText size={14} />
                                  <span>{document.title}</span>
                                  <small>{document.kind} · {formatBytes(document.sizeBytes)}</small>
                                </button>
                              ))}
                            </details>
                          ))
                        )}
                      </div>
                    </div>

                    <div className="ops-panel">
                      <div className="ops-panel-header">
                        <h3>Agent Tools</h3>
                        <button
                          type="button"
                          className="ops-button ghost"
                          onClick={() => {
                            void opsApi.getAgentToolCatalog(true).then((response) => setToolCatalog(response.catalog)).catch(handleError);
                          }}
                        >
                          <RefreshCw size={14} /> Scan
                        </button>
                      </div>
                      <div className="ops-panel-body ops-agent-tool-list">
                        {toolGroups.length === 0 ? (
                          <div className="ops-helper">Tool catalog unavailable.</div>
                        ) : (
                          toolGroups.map((group) => (
                            <details key={group.category} className="ops-agent-side-details" open={group.category === 'workspace'}>
                              <summary>
                                <ChevronRight size={14} />
                                {group.category}
                                <span>{group.tools.length}</span>
                              </summary>
                              {group.tools.map((tool) => (
                                <button
                                  key={tool.id}
                                  type="button"
                                  className="ops-agent-tool-button"
                                  data-selected={selectedToolNames.includes(tool.id)}
                                  onClick={() => toggleToolFocus(tool)}
                                  title={tool.promptPath || tool.toolPath || tool.id}
                                >
                                  <Wrench size={14} />
                                  <span>{tool.displayName}</span>
                                  <small>{tool.description}</small>
                                </button>
                              ))}
                            </details>
                          ))
                        )}
                      </div>
                    </div>

                    <div className="ops-panel">
                      <div className="ops-panel-header">
                        <h3>Bridge Control</h3>
                        <span className="ops-mini-badge"><Code2 size={14} /> {terminals.cli.running ? 'CLI live' : 'CLI idle'}</span>
                      </div>
                      <div className="ops-panel-body">
                        <div className="ops-action-row ops-bridge-actions">
                          <button className="ops-button ghost" onClick={() => { void startTerminal('cli'); }} type="button">
                            <Play size={16} /> Start
                          </button>
                          <button className="ops-button ghost" onClick={() => { void stopTerminal('cli'); }} type="button">
                            <Square size={16} /> Stop
                          </button>
                          <button className="ops-button ghost" onClick={() => { void ctrlCTerminal('cli'); }} type="button">
                            <Square size={16} /> Ctrl-C
                          </button>
                        </div>
                        <BridgeWorkflowPanel
                          bridge={bridge}
                          sessionId={sessionId}
                          assistantSeed={assistantSeed}
                          busyAction={bridgeBusyAction}
                          onHandoff={handoffToCli}
                          onReturn={returnToAgent}
                          onCancel={cancelBridge}
                        />
                      </div>
                    </div>
                  </aside>
                </div>
              </section>
            )}
          </main>
        )}
      </div>
    </div>
  );
}

function activeLayerCount(layers: MapLayer[], assets?: MapAsset[]) {
  if (!assets) return layers.filter((layer) => layer.visible).length;
  const visibleAssetIds = new Set(assets.map((asset) => asset.id));
  return layers.filter((layer) => layer.visible && layer.assetIds.some((assetId) => visibleAssetIds.has(assetId))).length;
}
