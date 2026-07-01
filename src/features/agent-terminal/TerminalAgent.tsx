/**
 * ROBIN Ops Agent Terminal
 * 
 * React wrapper for xterm.js PTY terminal
 */

import { useEffect, useRef, useCallback, useState, useMemo, forwardRef, useImperativeHandle } from 'react'
import { Terminal } from 'xterm'
import { FitAddon } from 'xterm-addon-fit'
import { WebLinksAddon } from 'xterm-addon-web-links'

import './terminal.css'

interface ServerMessage {
  type: 'connected' | 'pong' | 'error' | 'exit' | 'resumed'
  message?: string
  exitCode?: number
  signal?: number
}

// ROBIN Ops Spinner Verbs - for active processing states
const ROBIN_SPINNER_VERBS = [
  'Synergizing', 'Operationalizing', 'De-risking', 'Mapping', 'Tightening',
  'Consulting', 'Aligning', 'Triangulating', 'Sleuthing', 'Correlating',
  'Observing', 'Indexing', 'Surfacing', 'Scheming', 'Redacting',
  'Hardening', 'Modeling', 'Deconflicting', 'Operationalizing',
  'Summoning', 'Appeasing', 'Rotating', 'Fingerprinting raccoons', 'Auditing',
  'Polishing the panopticon', 'Waterboarding the JSON', 'Teaching Excel fear',
  'Encrypting', 'Disambiguating', 'Backtracing', 'Staring into procurement',
  'Proselytizing the data', 'Reading the runes', 'Consulting the owl',
  'Whispering to the ontology', 'Performing graph liturgy', 'Blessing the data lake',
  'Baptizing the pipeline', 'Invoking the dashboard', 'Monitoring',
  'Watching', 'Locking', 'Checking', 'Closing', 'Sanitizing', 'Containing',
  'Redacting', 'Escalating', 'Deconflicting', 'Hardening',
]

interface TerminalAgentProps {
  sessionId?: string
  wsEndpoint?: string
  cols?: number
  rows?: number
  onSessionStateChange?: (connected: boolean) => void
}

export interface TerminalAgentHandle {
  focus: () => void
  write: (data: string) => void
  clear: () => void
  startSpinner: () => void
  stopSpinner: () => void
  updateTokenCount: (count: number) => void
}
// TerminalRef is kept for backward compatibility with earlier versions
export interface TerminalRef extends TerminalAgentHandle {}

// Spinner verb rotation interval
const SPINNER_VERB_INTERVAL_MS = 3500

const RECONNECT_BASE_MS = 1000
const RECONNECT_MAX_MS = 30000
const PING_INTERVAL_MS = 5000

export const TerminalAgent = forwardRef<TerminalRef, TerminalAgentProps>(function TerminalAgent(props, ref) {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const wsRef = useRef<WebSocket | null>(null)

  // @ts-ignore
  const [isConnected, setIsConnected] = useState(false)
  const [status, setStatus] = useState<'connected' | 'connecting' | 'disconnected' | 'processing'>('connecting')
  const [spinnerVerbIndex, setSpinnerVerbIndex] = useState(0)
  const isProcessing = status === 'processing'

  const reconnectDelayRef = useRef(RECONNECT_BASE_MS)
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const spinnerTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const { wsEndpoint = '/api/agent-terminal/ws', cols = 80, rows = 24, onSessionStateChange } = props

  const initTerminal = useCallback(() => {
    if (!containerRef.current) return

    const term = new Terminal({
      cursorBlink: true,
      cursorStyle: 'block',
      fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
      fontSize: 14,
      lineHeight: 1.2,
      theme: {
        background: '#0f110d',
        foreground: '#dcd5c2',
        cursor: '#dcd5c2',
        selectionBackground: 'rgba(184, 167, 103, 0.3)',
      },
      allowProposedApi: true,
      scrollback: 10000,
      convertEol: true,
      rows,
      cols,
    })

    const fitAddon = new FitAddon()
    term.loadAddon(fitAddon)
    term.loadAddon(new WebLinksAddon())
    term.open(containerRef.current)
    fitAddon.fit()

    const resizeObserver = new ResizeObserver(() => fitAddon.fit())
    resizeObserver.observe(containerRef.current)

    term.onResize(({ cols, rows }) => {
      sendJSON({ type: 'resize', cols, rows })
    })

    term.onData((data) => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(data)
      }
    })

    termRef.current = term
    fitAddonRef.current = fitAddon
  }, [cols, rows])

  const getWsUrl = useCallback(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const url = new URL(protocol + '//' + window.location.host + wsEndpoint)
    if (props.sessionId) url.searchParams.set('resume', props.sessionId)
    url.searchParams.set('cols', String(cols))
    url.searchParams.set('rows', String(rows))
    return url.toString()
  }, [wsEndpoint, props.sessionId, cols, rows])

  const sendJSON = useCallback((msg: Record<string, unknown>) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg))
    }
  }, [])

  const connect = useCallback(() => {
    setStatus('connecting')
    setIsConnected(false)
    const ws = new WebSocket(getWsUrl())

    ws.addEventListener('open', () => {
      setIsConnected(true)
      setStatus('connected')
      reconnectDelayRef.current = RECONNECT_BASE_MS
      startPing()
      onSessionStateChange?.(true)
    })

    ws.addEventListener('message', (event: MessageEvent<string>) => {
      const data = event.data
      if (data.startsWith('{')) {
        try {
          const msg = JSON.parse(data) as ServerMessage
          handleControlMessage(msg)
          return
        } catch {}
      }
      if (termRef.current) termRef.current.write(data)
    })

    ws.addEventListener('close', onDisconnect)
    wsRef.current = ws
  }, [getWsUrl, onSessionStateChange])

  const handleControlMessage = useCallback((msg: ServerMessage) => {
    switch (msg.type) {
      case 'connected':
      case 'resumed':
        setIsConnected(true)
        setStatus('connected')
        onSessionStateChange?.(true)
        break
      case 'pong':
        break
      case 'error':
        if (termRef.current) termRef.current.write('[error] ' + msg.message + '\r\n')
        break
      case 'exit':
        setIsConnected(false)
        setStatus('disconnected')
        onSessionStateChange?.(false)
        break
    }
  }, [onSessionStateChange])

  const onDisconnect = useCallback(() => {
    setIsConnected(false)
    setStatus('disconnected')
    stopPing()
    scheduleReconnect()
    onSessionStateChange?.(false)
  }, [onSessionStateChange])

  const scheduleReconnect = useCallback(() => {
    if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current)
    reconnectTimerRef.current = setTimeout(() => {
      if (termRef.current) connect()
    }, reconnectDelayRef.current)
    reconnectDelayRef.current = Math.min(reconnectDelayRef.current * 2, RECONNECT_MAX_MS)
  }, [connect])

  const startPing = useCallback(() => {
    stopPing()
    pingTimerRef.current = setInterval(() => {
      if (wsRef.current?.readyState === WebSocket.OPEN) sendJSON({ type: 'ping' })
    }, PING_INTERVAL_MS)
  }, [sendJSON])

  const stopPing = useCallback(() => {
    if (pingTimerRef.current) clearInterval(pingTimerRef.current)
    pingTimerRef.current = null
  }, [])

  const startSpinner = useCallback(() => {
    setStatus('processing')
    setSpinnerStartTime(Date.now())
    setTokenCount(null)
    return () => {
      if (spinnerTimerRef.current) clearTimeout(spinnerTimerRef.current)
      spinnerTimerRef.current = null
    }
  }, [])

  const stopSpinner = useCallback(() => {
    if (spinnerTimerRef.current) clearInterval(spinnerTimerRef.current)
    spinnerTimerRef.current = null
    setStatus('connected')
    setSpinnerVerbIndex(0)
  }, [])

  const rotateSpinnerVerb = useCallback(() => {
    if (!isProcessing) return
    setSpinnerVerbIndex((prev) => (prev + 1) % ROBIN_SPINNER_VERBS.length)
  }, [isProcessing])

  // Timing and stats for spinner verb
  const [spinnerStartTime, setSpinnerStartTime] = useState<number | null>(null)
  const [tokenCount, setTokenCount] = useState<number | null>(null)

  // Update spinner verb display with timing and token stats
  const spinnerVerbWithStats = useMemo(() => {
    if (!isProcessing || spinnerStartTime === null) return ROBIN_SPINNER_VERBS[spinnerVerbIndex]

    const elapsedMs = Date.now() - spinnerStartTime
    const elapsedSeconds = Math.floor(elapsedMs / 1000)
    const minutes = Math.floor(elapsedSeconds / 60)
    const seconds = elapsedSeconds % 60
    const timeStr = minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`

    const tokenStr = tokenCount !== null ? `↓ ${tokenCount}t` : ''

    return `${ROBIN_SPINNER_VERBS[spinnerVerbIndex]}... (${timeStr} ${tokenStr})`
  }, [isProcessing, spinnerStartTime, spinnerVerbIndex, tokenCount])

  useEffect(() => {
    if (isProcessing) {
      setSpinnerVerbIndex(0)
      rotateSpinnerVerb()
      spinnerTimerRef.current = setInterval(rotateSpinnerVerb, SPINNER_VERB_INTERVAL_MS)
    }
    return () => {
      if (spinnerTimerRef.current) clearInterval(spinnerTimerRef.current)
      spinnerTimerRef.current = null
    }
  }, [isProcessing, rotateSpinnerVerb])

  useEffect(() => {
    initTerminal()
    connect()
    return () => {
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current)
      stopPing()
      wsRef.current?.close()
      termRef.current?.dispose()
    }
  }, [initTerminal, connect, stopPing])

  useImperativeHandle(ref, () => ({
    focus: () => termRef.current?.focus(),
    write: (data) => termRef.current?.write(data),
    clear: () => termRef.current?.clear(),
    startSpinner,
    stopSpinner,
    updateTokenCount: (count) => setTokenCount(count),
  }), [startSpinner, stopSpinner, setTokenCount])

  return (
    <div className="robin-terminal-container">
      <div className="robin-terminal-status-bar">
        <span className={'status-dot ' + status} />
        <span className="status-text">
          {isProcessing
            ? spinnerVerbWithStats
            : status}
        </span>
      </div>
      <div className="robin-terminal-status-tips">
        <span className="tip-label">Tip:</span>
        <span className="tip-text">
          {isProcessing
            ? 'Press Ctrl+C to interrupt processing'
            : 'Press Ctrl+P to open command palette'}
        </span>
      </div>
      <div className="robin-terminal-viewport">
        <div ref={containerRef} className="robin-terminal-canvas" />
      </div>
    </div>
  )
})
