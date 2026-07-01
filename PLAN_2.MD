 Phase 1: Extract & Embed Terminal Frontend (~30 min)

  Files to COPY (minimal changes needed):

  Source: Atlas-Code/src/server/web/terminal.ts
  Destination: src/features/agent-terminal/TerminalAgent.tsx
  Purpose: xterm.js frontend as React component
  ────────────────────────────────────────
  Source: Atlas-Code/src/server/web/styles.css
  Destination: src/features/agent-terminal/terminal.css
  Purpose: Terminal styling (ROBIN-theme via CSS vars)

  Key modifications to terminal.ts:

  1. Wrap in React component — convert vanilla DOM init to a useEffect hook that mounts/unmounts
  xterm
  2. ROBIN theme mapping — replace getTheme() to read from ROBIN's existing CSS custom properties
  (--robin-bg, etc.) or pass via props
  3. WebSocket URL — change from /ws to /api/agent-terminal/ws (ROBIN route)
  4. Remove standalone HTML dependencies — the loading/reconnect overlays become React state-driven
  UI elements

  Files to REMOVE from ROBIN:

  ┌──────────────────────────────────────────────┬────────────────────────────────────┐
  │                     Path                     │               Reason               │
  ├──────────────────────────────────────────────┼────────────────────────────────────┤
  │ src/features/chat/ (~30 files)               │ Replaced by terminal agent         │
  ├──────────────────────────────────────────────┼────────────────────────────────────┤
  │ src/contexts/ChatContext.tsx                 │ No longer needed                   │
  ├──────────────────────────────────────────────┼────────────────────────────────────┤
  │ src/hooks/useChatMessages.ts                 │ No longer needed                   │
  ├──────────────────────────────────────────────┼────────────────────────────────────┤
  │ src/hooks/useChatStreaming.ts                │ No longer needed                   │
  ├──────────────────────────────────────────────┼────────────────────────────────────┤
  │ src/hooks/useChatRecovery.ts                 │ No longer needed                   │
  ├──────────────────────────────────────────────┼────────────────────────────────────┤
  │ src/hooks/useChatTTS.ts                      │ Keep but rewire to terminal output │
  ├──────────────────────────────────────────────┼────────────────────────────────────┤
  │ src/components/skeletons/MessageSkeleton.tsx │ No longer needed                   │
  └──────────────────────────────────────────────┴────────────────────────────────────┘

  ---
  Phase 2: Server-Side PTY Route (~1 hr)

  New file: server/routes/agent-terminal.ts

  Adapted from Atlas Code's pty-server.ts, but integrated into ROBIN's existing Express app rather
  than standalone:

  // Key differences from Atlas-Code pty-server.ts:
  // 1. Mounts as router, not standalone server
  // 2. Spawns "atlas" CLI with ROBIN-specific env vars
  // 3. Uses ROBIN's existing auth/session context
  // 4. Shares the same Express app instance

  What it does:

  - WebSocket endpoint at /api/agent-terminal/ws — mirrors Atlas Code protocol exactly
  - Spawns PTY running atlas (the bundled CLI) with env vars pointing to ROBIN's workspace, gateway
  config, and LLM settings
  - Session management — reuses Atlas Code's SessionManager class (copy or adapt)
  - Scrollback buffer — keeps last N KB of output for reconnect resume

  Files to COPY from Atlas Code:

  ┌──────────────────────┬────────────────────────────────────────┬────────────────────────────┐
  │        Source        │              Destination               │          Purpose           │
  ├──────────────────────┼────────────────────────────────────────┼────────────────────────────┤
  │ session-manager.ts   │ server/lib/terminal-session-manager.ts │ Session lifecycle          │
  ├──────────────────────┼────────────────────────────────────────┼────────────────────────────┤
  │ session-store.ts     │ (inline)                               │ In-memory session store    │
  ├──────────────────────┼────────────────────────────────────────┼────────────────────────────┤
  │ scrollback-buffer.ts │ (inline)                               │ Ring buffer for PTY output │
  └──────────────────────┴────────────────────────────────────────┴────────────────────────────┘

  Files to MODIFY in ROBIN:

  ┌─────────────────┬──────────────────────────────────────────┐
  │      Path       │                  Change                  │
  ├─────────────────┼──────────────────────────────────────────┤
  │ server/index.ts │ Mount new router at /api/agent-terminal  │
  ├─────────────────┼──────────────────────────────────────────┤
  │ src/App.tsx     │ Replace <ChatPanel> with <TerminalAgent> │
  └─────────────────┴──────────────────────────────────────────┘

  ---
  Phase 3: Atlas Code CLI Configuration (~1 hr)

  The spawned process needs to know it's running inside ROBIN:

  Environment variables passed to PTY spawn:
  ROBIN_MODE=1                    # Tells Atlas Code to run in embedded mode
  ROBIN_GATEWAY_URL=<gateway>     # Gateway for tool calls
  ROBIN_GATEWAY_TOKEN=<token>     # Auth token
  ROBIN_WORKSPACE_DIR=<path>      # Workspace root
  ROBIN_LLM_BASE_URL=<url>        # Local LLM endpoint (lmstudio, etc.)
  ROBIN_LLM_API_KEY=<key>         # LLM auth
  ROBIN_MODEL_ID=<model>          # Default model

  Atlas Code modifications needed:

  In src/entrypoints/cli.tsx or a new src/robin-embedded.ts:
  1. Detect ROBIN_MODE=1 early in bootstrap
  2. Skip Ink TUI rendering (we're in xterm, not a real terminal)
  3. Use ROBIN env vars for gateway/LLM config instead of Anthropic auth
  4. Output agent loop directly to stdout/stderr (xterm captures this)

  ---
  Phase 4: App.tsx Integration (~30 min)

  Changes to src/App.tsx:

  - import { useChat } from '@/contexts/ChatContext';
  + import { TerminalAgent } from '@/features/agent-terminal/TerminalAgent';

  - const { messages, sendMessage, ... } = useChat();
  + // No chat context needed — terminal handles everything

  // Replace ChatPanel with TerminalAgent in the layout:
  - <ChatPanel ref={chatPanelRef} className="..." />
  + <TerminalAgent
  +   sessionId={currentSession?.id}
  +   workspacePath={workspaceDir}
  +   className="flex-1"
  + />

  Keep these working alongside terminal:

  ┌─────────────────────────────┬──────────────────────────────────────────────────────┐
  │           Feature           │                        Status                        │
  ├─────────────────────────────┼──────────────────────────────────────────────────────┤
  │ Voice input (useVoiceInput) │ Rewire to send text to terminal stdin via WebSocket  │
  ├─────────────────────────────┼──────────────────────────────────────────────────────┤
  │ TTS (useTTSConfig)          │ Wire to consume terminal stdout for read-aloud       │
  ├─────────────────────────────┼──────────────────────────────────────────────────────┤
  │ File browser                │ Unchanged — agent can reference files by path        │
  ├─────────────────────────────┼──────────────────────────────────────────────────────┤
  │ Kanban board                │ Unchanged — agent updates via tool calls             │
  ├─────────────────────────────┼──────────────────────────────────────────────────────┤
  │ Map view                    │ Unchanged                                            │
  ├─────────────────────────────┼──────────────────────────────────────────────────────┤
  │ Settings panel              │ Add LLM model selection that feeds into terminal env │
  └─────────────────────────────┴──────────────────────────────────────────────────────┘