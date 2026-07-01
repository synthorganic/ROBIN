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
