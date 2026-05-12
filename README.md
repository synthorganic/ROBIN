# ROBIN — Inertiai Ops Control Surface

ROBIN is the local-first operations workspace for Inertiai Ops. It brings the status overview, project document intake, agent chat, CLI bridge, and geo-linked operations map into one browser UI.

ROBIN can talk directly to a local OpenAI-compatible API such as LM Studio, llama.cpp server, or vLLM. It can also bridge to a compatible agent gateway when that runtime is available.

## Features

- **Status Overview** - Operational status, activity summaries, document intake, and project-organized document lists
- **Agent Chat** - Chat-style agent session with local API setup, model selection, tool output, and document access
- **Local API Wire** - OpenAI-compatible base URL, API key, and model polling for LM Studio-style local inference
- **Task Management** - Kanban boards for proposals, execution tracking, and agent task management
- **Workspace Browser** - File explorer with inline code editors and CLI bridge access
- **Geo Ops Map** - Project-linked map entities, relationship analysis, and local ops data storage
- **Voice Interaction** - Push-to-talk voice input, wake word detection, and text-to-speech audio output
- **Local-First Architecture** - Runs on your machine with optional remote gateway connectivity

## Quick Start

### Prerequisites

- Node.js >= 22.x
- npm (bundled with Node)
- Optional: a local OpenAI-compatible API such as LM Studio on `http://127.0.0.1:1234`
- Optional: a compatible agent gateway for gateway-backed memory, skill, and session operations

### Installation (Linux/macOS)

```bash
# Option 1: One-command automated installer
curl -fsSL https://raw.githubusercontent.com/synthorganic/ROBIN/main/install.sh | bash

# Option 2: Manual installation
git clone https://github.com/synthorganic/ROBIN.git
cd ROBIN
npm install
npm run setup
```

### Starting the Server

```bash
# Development mode (separate frontend/backend with HMR)
npm run dev       # Frontend on :3080
npm run dev:server # Backend on :3081

# Production mode
npm start         # Serves built assets from :3080
```

Visit http://localhost:3080 (or the configured port) to access ROBIN.

## Configuration

ROBIN looks for settings in a `.env` file. Run `npm run setup` for an interactive
configuration wizard, or manually edit `.env` with these key options:

- `LOCAL_API_BASE_URL` — OpenAI-compatible local API base URL, for example `http://127.0.0.1:1234`
- `LOCAL_API_KEY` — Local API key; LM Studio commonly accepts any non-empty value
- `LOCAL_API_MODEL` — Default local model when the API does not provide one
- `GATEWAY_TOKEN` — Authentication token for a compatible agent gateway
- `GATEWAY_URL` — URL of the gateway server
- `PORT` — Server port (default: 3080)
- `HOST` — Bind address (default: 127.0.0.1, set to 0.0.0.0 for network access)
- `ROBIN_AUTH`/`ROBIN_PASSWORD_HASH` — Enable password protection

## Project Structure

```
├── src/                 # Frontend (React + TypeScript)
│   ├── features/        # Product surfaces and feature-local helpers
│   │   ├── activity/    # Agent log and event log panels
│   │   ├── auth/        # Login gate and auth flows
│   │   ├── charts/      # Inline chart extraction and renderers
│   │   ├── chat/        # Chat UI, message loading, streaming operations
│   │   ├── command-palette/  # ⌘K command palette
│   │   ├── connect/     # Gateway connect dialog
│   │   ├── dashboard/   # Token usage and memory list views
│   │   ├── file-browser/# Workspace tree, tabs, editors
│   │   ├── kanban/      # Task board, proposals, execution views
│   │   ├── markdown/    # Markdown and tool output rendering
│   │   ├── memory/      # Memory editing dialogs and hooks
│   │   ├── sessions/    # Session list, tree helpers, spawn flows
│   │   ├── settings/    # Settings drawer and audio controls
│   │   ├── tts/         # Text-to-speech playback/config
│   │   ├── voice/       # Push-to-talk, wake word, audio feedback
│   │   └── workspace/   # Workspace-scoped panels and state
│   ├── components/      # Shared UI building blocks
│   ├── contexts/        # Gateway, session, chat, and settings contexts
│   ├── hooks/           # Cross-cutting hooks used across features
│   └── lib/             # Utility libraries
├── server/              # Backend API (Hono + TypeScript)
├── skills/              # Agent skill packages
└── docs/                # Detailed documentation
```

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md) for local development setup, testing,
and pull request guidelines.

## License

[MIT License](LICENSE)
