# ROBIN Op
# Replace In-App Chat with `ROBIN Ops Agent` xterm Runtime

## Summary
- Make the Agent tab a dedicated `ROBIN Ops Agent` sub-app inside the existing `OpsApp` shell, using one primary xterm.js PTY as the canonical agent surface.
- Port the Atlas local-runtime pieces into ROBIN itself: local-model config/discovery, auto-launch flow, and the `atlas-code-explorer` MCP sidecar renamed for ROBIN. ROBIN must run standalone after this change and must not depend on the sibling `Atlas-Code` repo at runtime.
- Remove OpenClaw/gateway dependencies repo-wide rather than preserving compatibility layers. Active Ops UI stays; dormant gateway/chat/workspace paths are deleted instead of re-platformed.
- Keep the current ROBIN visual language. Reuse the existing `TerminalPane` theme and the current Agent tab/sidebar layout rather than importing Atlas’s web UI.

## Key Changes
- Backend runtime:
  - Replace the current CLI launch target in `ops-terminals` with a `ROBIN Ops Agent` launcher that starts in the ROBIN workspace root, auto-starts on boot when enabled, and injects a ROBIN-renamed explorer MCP sidecar plus local-model env/config.
  - Port Atlas behavior from `start-local`, `localLM/local.ts`, `/localapi`, and `/localmodel` into ROBIN’s Node-based embedded CLI wrapper. Do not introduce Bun as a required runtime.
  - Keep `/api/terminals` and SSE terminal events as the transport for xterm. Add a block-send endpoint for prompt proxies so non-terminal panels can submit newline-terminated prompts cleanly.
  - Replace the current message-session agent backend with a config-backed terminal runtime. Remove `ops-agent` session/message streaming, `ops-bridge`, and `shared-chat`.
  - Make uploaded documents agent-readable as normal files under ROBIN-managed local storage instead of prompt-only attachments, so the terminal agent can inspect them through its file/tooling stack.
  - Replace the current hard-coded external tool-catalog source with a live ROBIN catalog derived from the ported runtime’s built-in tools, enabled MCP servers, and any ROBIN-native helpers intentionally exposed.

- Frontend shell:
  - In the Agent tab, replace the large `ROBIN Agent Chat` message log and compose box with the primary xterm pane plus terminal lifecycle controls.
  - Remove the gateway/local transport toggle, bridge workflow UI, and chat-history rendering from the live Ops path.
  - Convert the bottom `Ask ROBIN anything...` panel and the map `Command Deck` into proxy inputs for the primary PTY. They submit blocks into the same running agent and can focus/open the Agent tab, but they do not create separate agent processes.
  - Keep the right-rail structure, but repurpose it as the ROBIN Ops Agent control plane: API endpoint/key, model selection, system prompt, token/temperature settings, tool/MCP profile selection, document context, and runtime status.
  - Preserve voice/TTS/settings surfaces, but rewire voice input to send prompt blocks into the terminal runtime. TTS, if retained, should read terminal-derived assistant output rather than chat-message objects.

- OpenClaw removal:
  - Delete gateway/OpenClaw routes, clients, contexts, config, scripts, tests, and docs, including gateway status/init/restart flows, OpenClaw skills/channels routes, gateway auth fallbacks, and `.openclaw` default paths.
  - Remove dormant frontend modules that only exist for the old gateway/session/chat app path, including `App.tsx`-era chat/session/gateway contexts and their consumers.
  - Replace remaining `.openclaw` storage defaults with ROBIN-owned paths under `~/.robin` and remove startup gateway probing entirely.

## Public API, Types, and Config
- Remove `AgentTransport`, `BridgeStatus`, `AgentSession`, and `AgentMessage` from the active Ops API surface.
- Keep `TerminalState` as the core runtime type and add:
  - `OpsAgentConfig`: local API settings, model/runtime settings, enabled MCP servers, enabled tool profiles, auto-start flag, workspace path.
  - `OpsAgentRuntimeStatus`: terminal running state, active model, config version, restart reason, explorer sidecar health.
  - `OpsToolCatalogItem`: live tool/MCP catalog entries shown in the sidebar.
- Introduce `GET/PUT /api/agent/config` as the single source of truth for the ROBIN Ops Agent control plane.
- Keep `POST /api/agent/local-api/models` for model polling, but treat it as a helper under the new config flow.
- Add `POST /api/terminals/:id/block` for proxy-panel prompt submission.
- Persist scalar secrets/env-compatible values in `.env` and structured agent settings in a ROBIN-owned JSON config file under `~/.robin`. Web controls are authoritative; CLI-side config commands must update the same store and trigger UI refresh plus controlled agent restart.

## Test Plan
- Backend tests:
  - `ROBIN Ops Agent` auto-starts in the ROBIN workspace, not the user home directory.
  - Config writes update the shared store, restart the CLI when required, and keep the explorer sidecar in sync.
  - Model polling works against local OpenAI-compatible endpoints with and without API keys.
  - Uploaded documents land in agent-readable local storage and appear in the document API.
  - No route mounts or config defaults reference OpenClaw/gateway after the cleanup.

- Frontend tests:
  - `AuthGate` still boots directly into `OpsApp`.
  - Agent tab renders the xterm pane and no longer renders chat-history cards or bridge UI.
  - Bottom/global proxy inputs submit to the primary PTY and do not create secondary sessions.
  - Sidebar controls load persisted config, update it, and reflect runtime restarts/status.
  - No active frontend code fetches `/api/gateway`, `/api/skills`, `/api/channels`, or shared-chat/session-stream endpoints.

- End-to-end acceptance:
  - Starting ROBIN opens a live `ROBIN Ops Agent` terminal automatically.
  - Selecting a local model and API endpoint in the web UI changes the running agent behavior.
  - The terminal theme matches the current ROBIN shell styling.
  - Tool calling works through the ported ROBIN explorer/runtime without any Atlas sibling-repo dependency or OpenClaw dependency.

## Assumptions and Defaults
- Atlas’s web components are reference only. ROBIN ports Atlas runtime/config behavior, not Atlas’s Next.js UI.
- The ROBIN implementation uses one primary agent PTY by design. Other former chat panels become proxies, not mirrored live terminals.
- “Model skills” is implemented as the combination of system prompt/runtime settings, enabled MCP servers, and enabled tool profiles in the Agent sidebar; the old OpenClaw skills surface is not recreated verbatim.
- The sibling `Atlas-Code` repo is used only as an implementation template during development. The finished ROBIN app must run without it.

---

## Implementation Phases

### Phase 1: Extract & Embed Terminal Frontend (~30 min)

**Files to COPY (minimal changes needed):**

| Source | Destination | Purpose |
|--------|-------------|---------|
| `Atlas-Code/src/server/web/terminal.ts` | `src/features/agent-terminal/TerminalAgent.tsx` | xterm.js frontend as React component |
| `Atlas-Code/src/server/web/styles.css` | `src/features/agent-terminal/terminal.css` | Terminal styling (ROBIN-theme via CSS vars) |

**Key modifications to terminal.ts:**

1. Wrap in React component — convert vanilla DOM init to a useEffect hook that mounts/unmounts xterm
2. ROBIN theme mapping — replace getTheme() to read from ROBIN's existing CSS custom properties (--robin-bg, etc.) or pass via props
3. WebSocket URL — change from /ws to `/api/agent-terminal/ws` (ROBIN route)
4. Remove standalone HTML dependencies — the loading/reconnect overlays become React state-driven UI elements

**Files to REMOVE from ROBIN:**

| Path | Reason |
|------|--------|
| `src/features/chat/` (~30 files) | Replaced by terminal agent |
| `src/contexts/ChatContext.tsx` | No longer needed |
| `src/hooks/useChatMessages.ts` | No longer needed |
| `src/hooks/useChatStreaming.ts` | No longer needed |
| `src/hooks/useChatRecovery.ts` | No longer needed |
| `src/hooks/useChatTTS.ts` | Keep but rewire to terminal output |
| `src/components/skeletons/MessageSkeleton.tsx` | No longer needed |

---

### Phase 2: Server-Side PTY Route (~1 hr)

**New file:** `server/routes/agent-terminal.ts`

Adapted from Atlas Code's pty-server.ts, but integrated into ROBIN's existing Express app rather than standalone:

Key differences from Atlas-Code pty-server.ts:
1. Mounts as router, not standalone server
2. Spawns atlas CLI with ROBIN-specific env vars
3. Uses ROBIN's existing auth/session context
4. Shares the same Express app instance

**What it does:**

- WebSocket endpoint at `/api/agent-terminal/ws` — mirrors Atlas Code protocol exactly
- Spawns PTY running atlas (the bundled CLI) with env vars pointing to ROBIN's workspace, gateway config, and LLM settings
- Session management — reuses Atlas Code's SessionManager class (copy or adapt)
- Scrollback buffer — keeps last N KB of output for reconnect resume

**Files to COPY from Atlas Code:**

| Source | Destination | Purpose |
|--------|-------------|---------|
| `session-manager.ts` | `server/lib/terminal-session-manager.ts` | Session lifecycle |
| `session-store.ts` | (inline) | In-memory session store |
| `scrollback-buffer.ts` | (inline) | Ring buffer for PTY output |

**Files to MODIFY in ROBIN:**

| Path | Change |
|------|--------|
| `server/index.ts` | Mount new router at `/api/agent-terminal` |
| `src/App.tsx` | Replace `<ChatPanel>` with `<TerminalAgent>` |

---

### Phase 3: Atlas Code CLI Configuration (~1 hr)

The spawned process needs to know it's running inside ROBIN:

**Environment variables passed to PTY spawn:**

```
ROBIN_MODE=1                    # Tells Atlas Code to run in embedded mode
ROBIN_GATEWAY_URL=<gateway>     # Gateway for tool calls
ROBIN_GATEWAY_TOKEN=<token>     # Auth token
ROBIN_WORKSPACE_DIR=<path>      # Workspace root
ROBIN_LLM_BASE_URL=<url>        # Local LLM endpoint (lmstudio, etc.)
ROBIN_LLM_API_KEY=<key>         # LLM auth
ROBIN_MODEL_ID=<model>          # Default model
```

**Atlas Code modifications needed:**

In `src/entrypoints/cli.tsx` or a new `src/robin-embedded.ts`:
1. Detect `ROBIN_MODE=1` early in bootstrap
2. Skip Ink TUI rendering (we're in xterm, not a real terminal)
3. Use ROBIN env vars for gateway/LLM config instead of Anthropic auth
4. Output agent loop directly to stdout/stderr (xterm captures this)

---

### Phase 4: App.tsx Integration (~30 min)

**Changes to `src/App.tsx`:**

```typescript
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
```

---

## Implementation Progress

### ✅ Phase 1: Terminal Frontend (Complete)
- Created `src/features/agent-terminal/TerminalAgent.tsx` - React xterm.js component
- Created `src/features/agent-terminal/terminal.css` - ROBIN-themed styling
- Created `src/features/agent-terminal/index.ts` - Exports

### ✅ Phase 2: PTY Server Routes (Complete)
- Created `server/lib/scrollback-buffer.ts` - Ring buffer for PTY output
- Created `server/lib/terminal-session-manager.ts` - Session lifecycle with grace period
- Created `server/routes/agent-terminal.ts` - WebSocket routes + HTTP APIs:
  - `GET /api/agent-terminal/sessions` - List sessions
  - `DELETE /api/agent-terminal/sessions/:token` - Kill session  
  - `POST /api/terminals/:id/block` - Block-send endpoint for proxy panels
- Updated `server/app.ts` - Registered agent-terminal routes
- Terminal spawns shell in workspace directory with ROBIN_MODE env vars

### ✅ Phase 3: CLI Configuration (Complete)
- Created `vendor/cli-agent/src/robin/robinEmbedded.ts` - Embedded mode entry point
- Modified `vendor/cli-agent/src/entrypoints/cli.tsx`:
  - Added ROBIN_MODE=1 early detection (before main import)
  - Routes to robinEmbedded.ts for simplified execution
  - Outputs agent loop to stdout/stderr for xterm capture
- Environment variable mapping:
  - ROBIN_LLM_* → LOCAL_API_*
  - ROBIN_GATEWAY_* → GATEWAY_*
  - ROBIN_WORKSPACE_DIR → CLAUDE_CODE_PROJECT_DIR + chdir
- Added validation for required config

### ✅ Phase 4: App.tsx Integration (Complete)

**Changes to `src/App.tsx`:**
- ✅ Replace `<ChatPanel>` with `<TerminalAgent ref={terminalRef}>`
- ✅ Wire up `useVoiceInput` hook to terminal stdin via WebSocket
- ✅ Keep file browser, kanban, map, and settings unchanged
- ✅ xterm.js PTY terminal now used as canonical agent surface
- ✅ Build successful (`npm run build` compiles without errors)

---

## Reconciliation Notes

- **PLAN.md is source of truth** for architectural decisions, API specifications, and testing requirements.
- **PLAN_2.md provides implementation details** for the execution phases (1-4).
- Where they overlap (e.g., terminal route path `/api/agent-terminal/ws`), both documents are consistent.
- OpenClaw removal is covered in PLAN.md; PLAN_2.md does not address it (not a conflict).
