# Deployment: Cloud (Remote Access)

Both ROBIN and Gateway hosted remotely. Access from any device, anywhere.

## Topology options

### Same host (recommended)

```
Browser (remote) → ROBIN cloud → Gateway cloud (same machine)
```

### Split hosts

```
Browser (remote) → ROBIN (host A) → Gateway (host B)
```

Same-host is simpler and has fewer failure points. Use split hosts only if you have a specific reason.

## Prerequisites

- Cloud Linux host with Node.js 22+
- OpenClaw gateway running
- Domain or stable IP for ROBIN
- TLS termination plan (reverse proxy or direct certs)

## Same-host setup

### 1. Install ROBIN

```bash
curl -fsSL https://raw.githubusercontent.com/daggerhashimoto/openclaw-ROBIN/master/install.sh | bash
```

### 2. Run setup with network access

```bash
cd ~/ROBIN
npm run setup
```

Recommended choices:
- Access mode: **Network** or **Custom**
- `HOST=0.0.0.0`
- **Enable authentication** and set a password
- Enable HTTPS if serving directly

### 3. Start the service

```bash
sudo systemctl restart ROBIN.service
sudo systemctl status ROBIN.service
```

### 4. Set up TLS

Put ROBIN behind a reverse proxy (Nginx, Caddy, or Traefik) that handles HTTPS and forwards HTTP + WebSocket traffic to ROBIN.

Or generate certs directly:

```bash
mkdir -p certs
openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout certs/key.pem -out certs/cert.pem -days 365 \
  -subj "/CN=your-domain.com"
```

ROBIN auto-detects certificates at `certs/cert.pem` and `certs/key.pem`.

## Split-host setup

Follow the same-host steps for ROBIN, then add:

### Install with remote gateway settings up front

```bash
curl -fsSL https://raw.githubusercontent.com/daggerhashimoto/openclaw-ROBIN/master/install.sh \
  | bash -s -- --gateway-url https://gw.example.com --gateway-token <token> --skip-setup
```

### Point ROBIN to remote gateway

In `.env`:

```bash
GATEWAY_URL=<remote-gateway-url>
WS_ALLOWED_HOSTS=<remote-gateway-hostname-or-ip>
NERVE_PUBLIC_ORIGIN=https://ROBIN.example.com
```

### Patch remote gateway allowed origins

On the gateway host, add ROBIN's public origin to `gateway.controlUi.allowedOrigins`:

```
https://ROBIN.example.com
```

### Ensure gateway tools allowlist

```json
"gateway": {
  "tools": {
    "allow": ["cron", "gateway", "sessions_spawn"]
  }
}
```

Restart both services.

## Validation

```bash
# ROBIN host
curl -sS http://127.0.0.1:3080/health

# Public endpoint
curl -sS https://<ROBIN-domain>/health
```

In the browser: login screen appears, connect succeeds, sessions load, messages work.

## Common issues

### Remote clients may still need manual credentials

Remote clients can still auto-connect when ROBIN trusts the request and the browser is using the official gateway URL. In that case `/api/connect-defaults` reports `serverSideAuth=true`, the browser sends an empty token, and ROBIN injects `GATEWAY_TOKEN` server-side during the WebSocket handshake.

Manual token entry is only required for custom gateway URLs or untrusted access paths.

### Reverse proxy and trusted proxy settings

Wrong IP detection affects rate limiting and logs.

**Fix:** Set `TRUSTED_PROXIES` in `.env` to your reverse proxy addresses.

## Security notes

- **Always** enable `NERVE_AUTH=true` for remote access
- Use HTTPS end-to-end or at least at the edge
- Keep the gateway on loopback when ROBIN and Gateway share a host
- Rotate gateway token on access changes

## Recommendation

Choose same-host unless you have a hard requirement for split hosts. It's easier to secure and support.
