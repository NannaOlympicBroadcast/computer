# `computer-agent` Plugin (Antigravity + Claude Code + OpenAI Codex CLI + Standalone CLI)

Unified plugin, MCP server, and standalone CLI for driving `@cloudflare/computer` workspaces across local Docker desktop containers, direct URLs, and remote **Tailscale** virtual-LAN (`Tailnet`) nodes.

## Supported Agent Platforms & Specifications

| Platform | Manifest / Config Files | Installed Path |
|---|---|---|
| **Google Antigravity** | `plugin.json`, `mcp_config.json`, `skills/computer-agent/SKILL.md`, `rules/AGENTS.md`, `assets/logo.svg` | `~/.gemini/config/plugins/computer-agent` |
| **Anthropic Claude Code** | `.claude-plugin/plugin.json`, `.mcp.json`, `mcp.json`, `commands/*.md`, `skills/computer-agent/SKILL.md` | `~/.claude/plugins/computer-agent` & `~/.claude/skills/computer-agent` |
| **OpenAI ChatGPT Codex CLI** | `codex-plugin.json`, `.codex/config.toml`, `skills/computer-agent/SKILL.md`, `rules/AGENTS.md` | `~/.codex/plugins/computer-agent`, `~/.agents/skills/computer-agent`, `<repo>/.agents/skills/computer-agent` |
| **Standalone CLI (`computer-cli`)** | `bin/computer-cli.mjs` | `~/.local/bin/computer-cli` (`computer-cli.cmd` on Windows) |

## Quick Install

From the repository root (after `npm run build`):

```bash
node plugins/computer-agent/scripts/install.mjs
```

This installs the plugin into Antigravity, Claude Code, and OpenAI Codex CLI simultaneously, writes `repo-root.json` so all installed copies resolve `@cloudflare/computer` directly, and creates the `computer-cli` wrapper in `~/.local/bin`.

---

## Using the Standalone CLI (`computer-cli`)

In environments where MCP tools are unavailable, disabled, or when shell commands are preferred, invoke `computer-cli` (or `node plugins/computer-agent/bin/computer-cli.mjs`). Every command outputs structured `{ ok, command, data }` JSON.

### 1. Connection & Tailscale Virtual-LAN Discovery

```bash
# Inspect active connection state, computerd health, and noVNC desktop URL
computer-cli status

# Start or attach to a local Docker desktop container (ports 8080, 5900, 6080)
computer-cli connect docker --port 8080 --novnc-port 6080 --secret local-dev-secret

# Discover Tailscale Tailnet peers and probe online nodes for running computerd instances
computer-cli tailscale peers --probe --port 8080

# Connect to a remote Tailscale peer by hostname, MagicDNS FQDN, Tailscale IP (100.x.y.z), or auto-probe
computer-cli connect tailscale ubuntu-gpu --port 8080 --secret local-dev-secret
computer-cli connect tailscale --magic-dns

# Connect to any explicit computerd URL
computer-cli connect url http://100.64.0.15:8080 --secret local-dev-secret
```

### 2. Shell Execution, Filesystem & Git

```bash
# Execute a command in the container
computer-cli exec 'uname -a && ls -la /workspace'

# Read, write, list, find, and grep files in the synced SQLite/FUSE workspace
computer-cli fs write /workspace/hello.txt "Hello from computer-cli"
computer-cli fs read /workspace/hello.txt
computer-cli fs ls /workspace --recursive
computer-cli fs find "*.ts" --path /workspace
computer-cli fs grep "TODO" --path /workspace
computer-cli sync push
computer-cli sync pull

# Built-in Git operations
computer-cli git init
computer-cli git add .
computer-cli git commit "Initial commit"
computer-cli git status
computer-cli git log
```

### 3. X11 GUI Desktop & Browser Automation

```bash
# Check X11 display, resolution, and noVNC preview URL
computer-cli desktop status

# Capture a PNG screenshot to disk
computer-cli desktop screenshot --out ./desktop.png

# Open a URL inside Chromium on the X11 desktop (:99)
computer-cli desktop open-url "https://live.48.cn/Index/main/club/1"

# List and focus X11 windows
computer-cli desktop windows
computer-cli desktop focus "Chromium"

# Mouse and keyboard control
computer-cli desktop click 640 360 --button left
computer-cli desktop double-click 640 360
computer-cli desktop right-click 640 360
computer-cli desktop move 400 300
computer-cli desktop drag 100 100 500 400
computer-cli desktop scroll down 5 --x 640 --y 400
computer-cli desktop type "SNH48"
computer-cli desktop key "Return"
```

---

## Using the MCP Server (`mcp/server.mjs`)

The stdio MCP server (`node plugins/computer-agent/mcp/server.mjs`) exposes 7 tools that share `~/.computer-agent/state.json` with `computer-cli`:

- `computer_status` — Inspect active mode (`url`, `tailscale`, `docker`, `local`), health, and X11 desktop status.
- `computer_connect` — Switch target mode (`docker`, `tailscale`, `url`, `local`).
- `computer_tailscale_peers` — Discover Tailnet peers and probe `http://<peer>:<port>/health`.
- `computer_exec` — Execute shell commands inside the container.
- `computer_fs` — `ls`, `read`, `write`, `find`, `grep`, `sync_push`, `sync_pull`.
- `computer_git` — `init`, `status`, `diff`, `log`, `add`, `commit`.
- `computer_desktop` — Full X11 GUI control (`status`, `screenshot` returning native MCP `type: "image"` blocks, `click`, `double_click`, `triple_click`, `right_click`, `move`, `drag`, `scroll`, `type`, `key`, `windows`, `focus_window`, `cursor_position`, `screen_size`, `clipboard_read`, `clipboard_write`, `wait`, `open_url`).
