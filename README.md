# ROBIN — OpenClaw Nerve Web Interface

A local-first web interface for the [OpenClaw](https://github.com/openclaw/openclaw) agent framework. 
Nerve provides a unified control surface with chat, task management (kanban), real-time voice interaction, 
and AI agent orchestration capabilities.

## Features

- **Interactive Chat Interface** - Real-time streaming chat with agents, message history, and markdown rendering
- **Task Management** - Kanban boards for proposals, execution tracking, and agent task management
- **Voice Interaction** - Push-to-talk voice input, wake word detection, and text-to-speech audio output
- **Workspace Browser** - File explorer with inline code editors and terminal emulation
- **Agent Activity Dashboard** - Live logs, token usage tracking, and memory management
- **Multi-Modal Output** - Support for charts, tables, code blocks, and formatted markdown content
- **Local-First Architecture** - Runs entirely on your machine with optional remote gateway connectivity

## Quick Start

### Prerequisites

- Node.js >= 22.x
- npm (bundled with Node)
- A running [OpenClaw](https://github.com/openclaw/openclaw) gateway

### Installation (Linux/macOS)

```bash
# Option 1: One-command automated installer
curl -fsSL https://raw.githubusercontent.com/daggerhashimoto/openclaw-nerve/master/install.sh | bash

# Option 2: Manual installation
git clone https://github.com/daggerhashimoto/openclaw-nerve.git
cd openclaw-nerve
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

Visit http://localhost:3080 (or the configured port) to access Nerve.

## Configuration

Nerve looks for settings in a `.env` file. Run `npm run setup` for an interactive 
configuration wizard, or manually edit `.env` with these key options:

- `GATEWAY_TOKEN` — Authentication token for your OpenClaw gateway (required)
- `GATEWAY_URL` — URL of your OpenClaw gateway server
- `PORT` — Server port (default: 3080)
- `HOST` — Bind address (default: 127.0.0.1, set to 0.0.0.0 for network access)
- `NERVE_AUTH`/`NERVE_PASSWORD_HASH` — Enable password protection

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
├── skills/              # OpenClaw skill packages
└── docs/                # Detailed documentation
```

## Development

See [CONTRIBUTING.md](docs/CONTRIBUTING.md) for local development setup, testing, 
and pull request guidelines.

## License

[MIT License](LICENSE)
