/**
 * useConnectionManager - Handles gateway connection lifecycle
 *
 * Extracted from App.tsx to separate connection concerns from layout.
 * Manages auto-connect on mount and reconnect logic.
 *
 * On first load, if no session config exists, fetches /api/connect-defaults
 * from the server to pre-fill (and auto-connect with) the configured gateway
 * URL and token. This bridges the server-side .env config to the browser.
 */
import { useState, useCallback, useEffect, useRef } from 'react';
import { useGateway, loadConfig, saveConfig } from '@/contexts/GatewayContext';
import { DEFAULT_GATEWAY_WS, DEFAULT_GATEWAY_TOKEN } from '@/lib/constants';

export interface ConnectionManagerState {
  dialogOpen: false;
  setDialogOpen: (open: boolean) => void;
  editableUrl: string;
  setEditableUrl: (url: string) => void;
  officialUrl: string | null;
  editableToken: string;
  setEditableToken: (token: string) => void;
  handleConnect: (url: string, token: string) => Promise<void>;
  handleReconnect: () => Promise<void>;
  serverSideAuth: boolean;
}

/** Create an AbortSignal that times out after `ms` milliseconds. */
function timeoutSignal(ms: number): AbortSignal {
  // AbortSignal.timeout() not supported in Safari <16.4
  if (typeof AbortSignal.timeout === 'function') return AbortSignal.timeout(ms);
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms);
  return controller.signal;
}

/** Fetch gateway connection defaults from the ROBIN server. */
async function fetchConnectDefaults(): Promise<{ wsUrl: string; token: string | null; authEnabled?: boolean; serverSideAuth?: boolean } | null> {
  try {
    const resp = await fetch('/api/connect-defaults', { signal: timeoutSignal(3000) });
    if (!resp.ok) return null;
    return await resp.json();
  } catch {
    return null;
  }
}

export function useConnectionManager(): ConnectionManagerState {
  const { connectionState, connect, disconnect } = useGateway();

  // Always return false for dialogOpen - we use automatic connection now
  const dialogOpen = false;
  const [serverSideAuth, setServerSideAuth] = useState(false);
  const [officialUrl, setOfficialUrl] = useState<string | null>(null);

  // Editable connection settings (local state for settings drawer)
  // Lazy initializers avoid re-parsing sessionStorage on every render
  const [editableUrl, setEditableUrl] = useState(() => loadConfig().url || DEFAULT_GATEWAY_WS);
  const [editableToken, setEditableToken] = useState(() => loadConfig().token || DEFAULT_GATEWAY_TOKEN);

  // Track connection attempts for retry logic
  const connectedRef = useRef(false);

  /** Connect to the gateway, save config. */
  const handleConnect = useCallback(async (url: string, token: string) => {
    saveConfig(url, token);
    await connect(url, token);
  }, [connect]);

  // Fetch server defaults and auto-connect on mount
  useEffect(() => {
    const saved = loadConfig();

    // Always fetch defaults to establish serverSideAuth and officialUrl
    fetchConnectDefaults().then((defaults) => {
      const isServerSideAuth = defaults?.serverSideAuth ?? false;
      setServerSideAuth(isServerSideAuth);

      const officialWsUrl = defaults?.wsUrl?.trim();

      if (officialWsUrl) {
        setOfficialUrl(officialWsUrl);
        // Use the server-provided gateway URL as authoritative
        setEditableUrl(officialWsUrl);
      }

      // Only override editableToken if it's currently empty
      if (!saved.token && defaults?.token) {
        setEditableToken(defaults.token);
      }

      if (isServerSideAuth && officialWsUrl) {
        setEditableToken('');
      }
    });
  }, []);

  // Auto-reconnect logic - retry connection every 5 seconds if not connected
  useEffect(() => {
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const retryConnection = () => {
      if (connectionState === 'connected') {
        if (!connectedRef.current) {
          console.log('[useConnectionManager] Connected to gateway successfully');
          connectedRef.current = true;
        }
        return;
      }

      if (connectionState === 'connecting' || connectionState === 'reconnecting') {
        // Already trying to connect, wait for it
        retryTimer = setTimeout(retryConnection, 1000);
        return;
      }

      // Not connected and not connecting - try to auto-connect
      const targetUrl = editableUrl || DEFAULT_GATEWAY_WS;
      const token = editableToken || '';

      if (targetUrl) {
        console.log('[useConnectionManager] Attempting auto-connect to:', targetUrl);
        handleConnect(targetUrl, token).catch((err) => {
          console.error('[useConnectionManager] Auto-connect failed:', err.message);
        });
      }

      // Retry every 5 seconds
      retryTimer = setTimeout(retryConnection, 5000);
    };

    retryConnection();

    return () => {
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [connectionState, editableUrl, editableToken, handleConnect]);

  const handleReconnect = useCallback(async () => {
    // Don't reconnect if already connecting
    if (connectionState === 'connecting' || connectionState === 'reconnecting') {
      return;
    }

    const targetUrl = editableUrl || DEFAULT_GATEWAY_WS;
    const token = editableToken || '';

    if (targetUrl) {
      console.log('[useConnectionManager] Manual reconnect to:', targetUrl);
      disconnect();
      await new Promise(r => setTimeout(r, 100));
      try {
        await connect(targetUrl, token);
      } catch (err) {
        console.error('[useConnectionManager] Reconnect failed:', err);
      }
    }
  }, [connect, disconnect, connectionState, editableUrl, editableToken]);

  return {
    dialogOpen,
    setDialogOpen: () => {}, // No-op - dialog is disabled
    editableUrl,
    setEditableUrl,
    officialUrl,
    editableToken,
    setEditableToken,
    handleConnect,
    handleReconnect,
    serverSideAuth,
  };
}
