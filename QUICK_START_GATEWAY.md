# ROBIN Gateway Quick Start

## What is the Gateway?

The ROBIN Gateway is a local HTTP/WS server that:
- Executes bash and PowerShell commands
- Provides tool invocation endpoints (`POST /tools/invoke`)
- Handles WebSocket RPC connections for real-time operations

## Why Use It?

**Without gateway:** Local-only mode, limited to file browser and chat
**With gateway:** Full features including document processing, tool execution

## Setup (One of Two Options)

### Option 1: Interactive Terminal Setup (Recommended)
```bash
npm run gateway:init

# Follow the prompts:
# - Select security level (token auth recommended)
# - Configuration saved to ~/.robin/gateway.json
```

### Option 2: Manual Setup
Create `~/.robin/gateway.json`:
```json
{
  "gateway": {
    "port": 18789,
    "bind": "127.0.0.1",
    "auth": {
      "mode": "token",
      "token": "YOUR_GENERATED_TOKEN_HERE"
    }
  }
}
```

Then add to `.env`:
```bash
GATEWAY_TOKEN=YOUR_GENERATED_TOKEN_HERE
```

## Generated Token Format

```
x7kP9mN2vQ5rT8wY1zA4bC6dE0fG2hJ3
```

Generated via `crypto.randomBytes(32).toString('base64url')`

## Testing Your Setup

```bash
# Test gateway is running
curl http://127.0.0.1:18789/health

# Test PowerShell execution (after setting GATEWAY_TOKEN)
curl -X POST http://localhost:3080/api/execute/powershell \
  -H "Content-Type: application/json" \
  -d '{"command": "Get-Process | Select-Object -First 3", "description": "List top processes"}'
```

## Default Configuration

| Setting | Value |
|---------|-------|
| Port | 18789 |
| Bind | 127.0.0.1 (localhost only) |
| Auth Mode | token |
| timeoutMs | 60000 (60s for PowerShell) |

## Where Configuration Lives

- **Windows:** `C:\Users\<user>\.robin\gateway.json`
- **Linux/macOS:** `/home/<user>/.robin/gateway.json`

## Need Help?

Run: `cat QUICK_START_GATEWAY.md` or check:
- `ROBIN_Gateway_Design.md` - Technical architecture
- `ROBIN_Gateway_Implementation_Plan.md` - Implementation details

