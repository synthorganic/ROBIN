# ROBIN Gateway v1 Design Document

## Overview

A lightweight, local-first gateway specifically designed for ROBIN that eliminates the OpenClaw dependency while maintaining compatibility with existing tools.

## Design Goals

1. **Local-only** - No external cloud dependencies
2. **Simple token generation** - Self-contained terminal-based setup
3. **Minimal dependencies** - Built on Node.js + Hono (already used by ROBIN)
4. **Direct execution** - Run commands locally without proxying

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    ROBIN UI                             │
│  ┌──────────────┬──────────────┬──────────────────┐    │
│  │ Chat Panel   │ Agents     │ Configuration     │    │
│  └──────────────┴──────────────┴──────────────────┘    │
└─────────────────────────────────────────────────────────┘
                          │
                    HTTP/WS API
                          │
┌─────────────────────────────────────────────────────────┐
│              ROBIN Gateway v1                           │
│  ┌───────────────────────────────────────────────────┐  │
│  │  /tools/invoke      - Tool execution endpoint    │  │
│  │  /ws                - WebSocket for RPC          │  │
│  │  /health            - Health check               │  │
│  └───────────────────────────────────────────────────┘  │
│                                                         │
│  Local Execution Engine                                 │
│  ├─ Bash/Shell commands                                │
│  ├─ PowerShell commands                                │
│  └─ Direct function calls                              │
└─────────────────────────────────────────────────────────┘
```

## Gateway Token Generation (Local Terminal)

### Current OpenClaw Approach
- Requires `openclaw` CLI
- Reads from `~/.openclaw/openclaw.json`
- Manual token generation or systemd setup

### Proposed ROBIN Gateway Approach
```bash
npm run gateway:init
# ^ This opens an interactive terminal session:
```

**Interactive Setup Flow:**
```
ROBIN Gateway Token Generator
───────────────────────────────

Step 1/3: Set your security level
[ ] Development (no auth - local only)
[X] Production (token authentication)

Step 2/3: Generating gateway token...
Generated token: abc123...xyz789

Step 3/3: Save to configuration?
✓ Saved to ~/.robin/gateway.json
```

## Core Endpoints

### `/tools/invoke` (POST)
```json
{
  "tool": "bash|powershell|files_list|memories_get|...',
  "args": {...},
  "sessionKey": "optional"
}
```

### `/ws` (WebSocket)
- RPC calls for real-time operations
- Session management
- Chat history

### `/health` (GET)
- Returns gateway status and version

## Local Execution Engine

```typescript
// Direct function execution (no gateway proxy)
{
  "bash": {
    command: string,
    cwd?: string,
    env?: Record<string, string>,
    timeoutMs?: number
  } => Promise<{ stdout: string; stderr: string; exitCode: number }>
}
```

## Configuration

```json
// ~/.robin/gateway.json
{
  "gateway": {
    "port": 18789,
    "bind": "127.0.0.1",
    "auth": {
      "mode": "token",
      "token": "generated_token_here"
    },
    "execution": {
      "localOnly": true,
      "allowedCommands": ["bash", "powershell"]
    }
  }
}
```

## Benefits Over OpenClaw Gateway

| Feature | OpenClaw | ROBIN Gateway |
|---------|----------|---------------|
| Setup | Requires openclaw CLI | Built-in terminal setup |
| Token Generation | Manual config file edit | Interactive terminal prompt |
| Dependencies | Full CLI suite | Node.js + Hono only |
| Network | Can bind 0.0.0.0 | Local-only by default |
| Complexity | Multi-agent support | Single-agent focus |

## Migration Path

1. Create new `robin-gateway` package
2. Maintain backward compatibility with `/tools/invoke` format
3. Gradually migrate from OpenClaw to ROBIN-native tools
4. Deprecate OpenClaw dependency in favor of local gateway

## Next Steps

- [ ] Implement basic HTTP server with Hono
- [ ] Create interactive token generation CLI
- [ ] Add bash/powershell execution engine
- [ ] Implement WebSocket RPC endpoint
- [ ] Test with existing ROBIN tool calls
