# ROBIN Gateway Implementation Plan

## Phase 1: Core Setup (Week 1)

### Tasks
- [ ] Create `server/lib/gateway-v1.ts` - New gateway implementation
- [ ] Add `/api/gateway/init` route for token generation
- [ ] Implement local execution engine in pure Node.js

### Files to Create
```
server/
├── lib/
│   ├── gateway-v1.ts          # Main gateway server (Hono-based)
│   └── gatewv-execution.ts    # Local command execution
└── routes/
    └── gateway-init.ts        # Token generation API
```

## Phase 2: Terminal Integration (Week 2)

### Tasks
- [ ] Create `scripts/gateway-init.ts` - Interactive setup CLI
- [ ] Add to package.json scripts: `"gateway:init": "tsx ./scripts/gateway-init.ts"`
- [ ] Test token generation workflow

## Phase 3: Documentation (Week 3)

### Tasks
- [ ] Update README.md with gateway setup instructions
- [ ] Document the new `/api/execute/*` endpoints
- [ ] Create Migration Guide for OpenClaw to ROBIN Gateway

## Phase 4: Deprecation Strategy (Week 4+)

### Tasks
- [ ] Mark OpenClaw as optional dependency
- [ ] Add deprecation warnings when using OpenClaw-only features
- [ ] Migrate core functionality to native gateway

---

## Token Generation Flow (Terminal-Based)

```bash
# User runs:
npm run gateway:init

# Output:
ROBIN Gateway Setup
────────────────────

Step 1/3: Security level selection
[ ] Development (no auth - local only)
[X] Production (token authentication) ← default

Step 2/3: Generating token...
Generated token: x7kP9mN2vQ5rT8wY1zA4bC6dE0fG2hJ3

Step 3/3: Save configuration? [Y/n] y

✓ Configuration saved to: C:\Users\benmc\.robin\gateway.json
```

## .env Entry Points

```bash
# Option 1: Token authentication (recommended)
GATEWAY_TOKEN=x7kP9mN2vQ5rT8wY1zA4bC6dE0fG2hJ3

# Option 2: Development mode (no auth)
NO_GATEWAY_AUTH=true

# Option 3: Use existing OpenClaw token
OPENCLAW_GATEWAY_TOKEN=existing_token_from_openclaw
```

---

## Implementation Checklist

### Gateway V1 Server (`server/lib/gateway-v1.ts`)
- [ ] Hono HTTP server (port 18789)
- [ ] `/health` endpoint
- [ ] `/tools/invoke` handler
- [ ] `/ws` WebSocket route
- [ ] Token authentication middleware
- [ ] Request logging

### Execution Engine (`server/lib/gateway-execution.ts`)
- [ ] Bash command execution via child_process.spawn
- [ ] PowerShell command execution via powershell -Command
- [ ] Timeout handling per command
- [ ] Output capture (stdout/stderr)
- [ ] Exit code reporting

### API Routes (`server/routes/gateway-init.ts`)
- [ ] POST `/api/gateway/init` - Generate and save token
- [ ] GET `/api/gateway/status` - Check current config
- [ ] DELETE `/api/gateway/config` - Reset configuration

---

## Testing Strategy

1. **Unit Tests**: Test execution engine directly
2. **Integration Tests**: Verify /tools/invoke works end-to-end
3. **E2E Tests**: Full setup flow from `npm run gateway:init`
4. **Compatibility Tests**: Ensure existing tools still work

---

## Migration Path for Users

### From OpenClaw Gateway:
1. `npm run gateway:init` - Generate new token
2. Update `.env` with new `GATEWAY_TOKEN`
3. Restart ROBIN
4. Verify: curl http://127.0.0.1:18789/health

### From Local-Only Mode:
No changes needed - gateway will auto-generate on first use.

## Future Enhancements

- [ ] OAuth token support for cloud integration
- [ ] Multi-user support with user-specific tokens
- [ ] Rate limiting per user/session
- [ ] request/response caching layer
