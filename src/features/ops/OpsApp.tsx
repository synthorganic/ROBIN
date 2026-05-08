import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  BarChart3,
  Biohazard,
  Bot,
  Code2,
  CornerDownLeft,
  DatabaseZap,
  FileText,
  Flame,
  Folder,
  Globe2,
  Layers3,
  LoaderCircle,
  LogOut,
  MapPinned,
  Orbit,
  Play,
  RadioTower,
  RefreshCw,
  Satellite,
  Send,
  ShieldCheck,
  Square,
  TerminalSquare,
} from 'lucide-react';
import BridgeWorkflowPanel from './BridgeWorkflowPanel';
import FuzzyText from './FuzzyText';
import LeafletMap from './LeafletMap';
import MapAssetInspector from './MapAssetInspector';
import TerminalPane from './TerminalPane';
import {
  opsApi,
  type AgentMessage,
  type AgentSession,
  type BridgeStatus,
  type MapAsset,
  type MapLayer,
  type MapSourceStatus,
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
    asset.notes ?? '',
    asset.status ?? '',
    asset.tags.join(' '),
  ]
    .join(' ')
    .toLowerCase();

  if (/(nuclear|reactor|radiological|uranium|plutonium|isotope)/.test(haystack)) return 'nuclear';
  if (/(bio|biological|pathogen|medical|clinical|plume|contamination)/.test(haystack)) return 'biological';
  if (/(ordnance|munition|weapon|missile|explosive|strike|launch)/.test(haystack)) return 'ordnance';
  if (/(logistics|route|cargo|port|shipping|vessel|supply|dock|freight)/.test(haystack)) return 'logistics';
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
    default:
      return <Folder size={16} />;
  }
}

function sourceStatusTone(source: MapSourceStatus | undefined) {
  if (!source) return 'idle';
  if (!source.enabled) return 'muted';
  if (source.ok) return source.stale ? 'stale' : 'ok';
  return source.stale ? 'stale' : 'error';
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
      const [sessionResult, terminalResult, bridgeResult, assetsResult, layersResult, sourcesResult] = await Promise.allSettled([
        activeSessionId ? opsApi.getSession(activeSessionId) : opsApi.createSession(),
        opsApi.listTerminals(),
        opsApi.getBridgeStatus(),
        opsApi.listAssets(),
        opsApi.listLayers(),
        opsApi.listSources(),
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

      const bootErrors = [
        sessionResult.status === 'rejected' ? `Central agent unavailable: ${formatError(sessionResult.reason)}` : '',
        terminalResult.status === 'rejected' ? `Terminal bus unavailable: ${formatError(terminalResult.reason)}` : '',
        bridgeResult.status === 'rejected' ? `Bridge status unavailable: ${formatError(bridgeResult.reason)}` : '',
        assetsResult.status === 'rejected' ? `Map assets unavailable: ${formatError(assetsResult.reason)}` : '',
        layersResult.status === 'rejected' ? `Map layers unavailable: ${formatError(layersResult.reason)}` : '',
        sourcesResult.status === 'rejected' ? `Map sources unavailable: ${formatError(sourcesResult.reason)}` : '',
      ].filter(Boolean);
      setError(bootErrors.join(' | '));
    } finally {
      if (mode === 'bootstrap') setLoading(false);
    }
  }, [applyTerminalStates]);

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
    setVisibleSources((current) => {
      const next: Record<string, boolean> = { manual: current.manual ?? true };
      for (const source of sourceStatuses) {
        next[source.id] = current[source.id] ?? true;
      }
      return next;
    });
  }, [sourceStatuses]);

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

  const writeTerminalInput = useCallback(
    async (terminalId: 'cli' | 'support', input: string) => {
      try {
        if (!terminals[terminalId].running) {
          const startResponse = await opsApi.startTerminal(terminalId);
          applyTerminalState(startResponse.terminal);
        }
        const writeResponse = await opsApi.writeTerminal(terminalId, input);
        applyTerminalState(writeResponse.terminal);
        clearError();
      } catch (nextError) {
        handleError(nextError);
      }
    },
    [applyTerminalState, clearError, handleError, terminals],
  );

  const resizeTerminal = useCallback(
    async (terminalId: TerminalState['id'], cols: number, rows: number) => {
      try {
        const response = await opsApi.resizeTerminal(terminalId, cols, rows);
        applyTerminalState(response.terminal);
        clearError();
      } catch (nextError) {
        handleError(nextError);
      }
    },
    [applyTerminalState, clearError, handleError],
  );

  const cliResizeCallback = useCallback(
    async (cols: number, rows: number) => {
      await resizeTerminal('cli', cols, rows);
    },
    [resizeTerminal],
  );

  const supportResizeCallback = useCallback(
    async (cols: number, rows: number) => {
      await resizeTerminal('support', cols, rows);
    },
    [resizeTerminal],
  );

  const cliInputCallback = useCallback(
    async (input: string) => {
      await writeTerminalInput('cli', input);
    },
    [writeTerminalInput],
  );

  const supportInputCallback = useCallback(
    async (input: string) => {
      await writeTerminalInput('support', input);
    },
    [writeTerminalInput],
  );

  const sendPrompt = useCallback(async () => {
    if (!sessionId || !prompt.trim() || sending) return;
    const nextPrompt = prompt.trim();
    setPrompt('');
    setSending(true);
    try {
      const response = await opsApi.sendMessage(sessionId, nextPrompt);
      setSession(response.session);
      clearError();
    } catch (nextError) {
      handleError(nextError);
    } finally {
      setSending(false);
    }
  }, [clearError, handleError, prompt, sending, sessionId]);

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

  useEffect(() => {
    if (activeTab !== 'agent' || terminals.cli.running) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentionally auto-start CLI lane when opening agent tab
    void startTerminal('cli');
  }, [activeTab, startTerminal, terminals.cli.running]);

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
    () => sourceStatuses.filter((source) => source.enabled && source.ok).length,
    [sourceStatuses],
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
        detail: `${sourceStatuses.length || 5} configured geospatial feeds; ${assets.filter((asset) => asset.live).length} live points loaded.`,
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
    [activeThreatCount, analyticsCount, assets, bridge.recentJobs.length, familyCounts.logistics, layers.length, liveSourceCount, reportCount, sourceStatuses.length],
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
                        <strong>{liveSourceCount}/{sourceStatuses.length || 5} live feeds healthy</strong>
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
                          title={source.status?.lastError || source.status?.attribution || source.label}
                        >
                          <span className="ops-layer-label">
                            {sourceIcon(source.id)}
                            {source.label}
                          </span>
                          <span className="ops-source-meta">
                            <span>{source.count}</span>
                            {source.status?.requiresKey && !source.status.enabled ? <span>key</span> : null}
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
                        <Layers3 size={14} /> {activeLayerCount(layers)} active map layers
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
              <section className="ops-terminals-layout">
                <div className="ops-panel">
                  <div className="ops-panel-body">
                    <div className="ops-terminal-topbar">
                      <div>
                        <div className="ops-section-kicker">Agent Workspace</div>
                        <h2>CLI-code lane, bridge control, and operator shell</h2>
                        <p className="ops-terminal-topbar-copy">
                          The primary lane launches the embedded coding agent when available, with a support shell and bridge log beside it.
                        </p>
                      </div>
                      <div className="ops-agent-kpis">
                        <span className="ops-mini-badge"><Code2 size={14} /> {terminals.cli.running ? 'CLI live' : 'CLI idle'}</span>
                        <span className="ops-mini-badge"><Bot size={14} /> {session?.label ?? 'No session'}</span>
                        <span className="ops-mini-badge"><DatabaseZap size={14} /> {liveSourceCount} feeds</span>
                      </div>
                    </div>
                  </div>
                </div>

                <div className="ops-terminal-grid">
                  <div className="ops-terminal-stack">
                    <div className="ops-panel">
                      <div className="ops-panel-header">
                        <h2>{terminals.cli.label}</h2>
                        <div className="ops-action-row">
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
                      </div>
                      <div className="ops-panel-body">
                        <div className="ops-terminal-meta">
                          <span className="ops-terminal-desc">Primary CLI-code lane for implementation and investigation tasks.</span>
                          <span className="ops-terminal-desc">Bridge handoffs are injected here with session context.</span>
                        </div>
                        <TerminalPane terminal={terminals.cli} onInput={cliInputCallback} onResize={cliResizeCallback} />
                      </div>
                    </div>

                    <div className="ops-terminal-bottom">
                      <div className="ops-panel">
                        <div className="ops-panel-header">
                          <h3>{terminals.support.label}</h3>
                          <div className="ops-action-row">
                            <button className="ops-button ghost" onClick={() => { void startTerminal('support'); }} type="button">
                              <Play size={16} /> Start
                            </button>
                            <button className="ops-button ghost" onClick={() => { void stopTerminal('support'); }} type="button">
                              <Square size={16} /> Stop
                            </button>
                          </div>
                        </div>
                        <div className="ops-panel-body">
                          <div className="ops-terminal-meta">
                            <span className="ops-terminal-desc">Support shell for diagnostics, probes, and local checks.</span>
                            <span className="ops-terminal-desc">Launches from the local user home directory.</span>
                          </div>
                          <TerminalPane
                            terminal={terminals.support}
                            onInput={supportInputCallback}
                            onResize={supportResizeCallback}
                          />
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="ops-panel">
                    <div className="ops-panel-header">
                      <h2>{terminals.logs.label}</h2>
                    </div>
                    <div className="ops-panel-body">
                      <div className="ops-terminal-meta">
                        <span className="ops-terminal-desc">
                          Active bridge session: {bridge.activeJob?.sessionId ?? 'none'}
                        </span>
                        <span className="ops-terminal-desc">Latest assistant seed: {assistantSeed ? 'available' : 'none'}</span>
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
                      <TerminalPane terminal={terminals.logs} />
                    </div>
                  </div>
                </div>
              </section>
            )}
          </main>
        )}
      </div>
    </div>
  );
}

function activeLayerCount(layers: MapLayer[]) {
  return layers.filter((layer) => layer.visible).length;
}
