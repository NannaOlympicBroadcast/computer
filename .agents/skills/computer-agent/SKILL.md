---
name: computer-agent
description: Control local Docker or remote Tailscale @cloudflare/computer instances (persistent SQLite VFS, Git, shell execution, and X11 GUI desktop automation) via MCP tools or the standalone computer-cli command-line tool. Activate when the user mentions cloud computer,云电脑, computerd, X11 desktop, VNC/noVNC, Tailscale remote computer, or wants to control a remote browser/desktop or sandboxed Linux environment.
---

# Computer Agent Skill (`@cloudflare/computer` MCP + CLI + Tailscale)

This skill enables an AI agent in **Google Antigravity**, **Anthropic Claude Code**, **OpenAI ChatGPT Codex CLI**, or any shell environment to drive a `@cloudflare/computer` workspace.

It supports **two interchangeable invocation modes** that share the same persistent connection state (`~/.computer-agent/state.json`) and local SQLite VFS (`~/.computer-agent/workspace.db`):

1. **MCP Tools (`computer_*`)** — Native Model Context Protocol tools with inline PNG screenshot blocks (`type: "image"`).
2. **Direct CLI (`computer-cli`)** — Standalone Node.js CLI (`plugins/computer-agent/bin/computer-cli.mjs` or `computer-cli` in `~/.local/bin`) with deterministic `{ ok, command, data }` JSON output for environments where MCP tools are unavailable, disabled, or when shell scripting is preferred.

---

## 1. Connection Modes (Local Docker, Direct URL, or Tailscale Virtual LAN)

Both the MCP server and the CLI support 4 connection modes:

| Mode | Description | Example |
|---|---|---|
| `docker` | Automatically boots or attaches to a local privileged Docker desktop container (`computerd-desktop:latest`) with Xvfb + Fluxbox + x11vnc + noVNC (`6080`) + `computerd` (`8080`). | `computer-cli connect docker` |
| `tailscale` | Discovers or resolves a remote `computerd` node on your **Tailscale Tailnet** (by short hostname, MagicDNS FQDN, `100.x.y.z` IPv4, or automatic `/health` probe across online peers). | `computer-cli connect tailscale ubuntu-gpu` |
| `url` | Connects to any explicit HTTP/WebSocket `computerd` endpoint on localhost, LAN, or VPN. | `computer-cli connect url http://127.0.0.1:8080 --secret local-dev-secret` |
| `local` | Pure local `NodeSQLiteStorage` workspace (`fs` + `git` only, no container required). | `computer-cli connect local` |

---

## 2. Mode A: Using Direct CLI (`computer-cli`) — Recommended When MCP Is Unavailable

Whenever MCP tools are not loaded or direct shell execution is more convenient, invoke `computer-cli` (installed at `~/.local/bin/computer-cli` or run directly via `node <repo>/plugins/computer-agent/bin/computer-cli.mjs`).

### 2.1 Connection & Tailscale Discovery Commands

```bash
# Inspect current connection, health, X11 desktop status, and noVNC URL
computer-cli status

# Start or attach to local Docker desktop container (ports 8080, 5900, 6080)
computer-cli connect docker --port 8080 --novnc-port 6080 --secret local-dev-secret

# Scan Tailscale Tailnet and probe online nodes for running computerd instances
computer-cli tailscale peers --probe --port 8080

# Connect to a remote Tailscale node by hostname, MagicDNS, IP, or auto-probe (omit peer)
computer-cli connect tailscale my-remote-workstation --port 8080 --secret local-dev-secret
computer-cli connect tailscale

# Connect to an explicit URL
computer-cli connect url http://100.64.0.12:8080 --secret local-dev-secret
```

### 2.2 Shell Execution, Filesystem & Git Commands

```bash
# Run a shell command inside the container via capnweb RPC
computer-cli exec "uname -a && ls -la /workspace" --cwd /workspace

# Virtual filesystem (persistent SQLite VFS) and FUSE bidirectional sync
computer-cli fs write /hello.txt "Hello from computer-cli"
computer-cli fs read /hello.txt
computer-cli fs ls / --recursive
computer-cli fs find "*.ts" --path /
computer-cli fs grep "TODO" --path /
computer-cli sync push
computer-cli sync pull

# Built-in Git operations on the Workspace VFS
computer-cli git init
computer-cli git add .
computer-cli git commit -m "Initial snapshot"
computer-cli git status
computer-cli git log
```

### 2.3 X11 GUI Desktop & Browser Automation Commands

```bash
# Check X11 display, resolution, and live noVNC URL
computer-cli desktop status

# Take a PNG screenshot and save to a local file
computer-cli desktop screenshot --output ./desktop.png

# Open a URL in Chromium on the X11 desktop (:99)
computer-cli desktop open-url "https://live.48.cn/Index/main/club/1"

# List and focus X11 windows
computer-cli desktop windows
computer-cli desktop focus "Chromium"

# Mouse and keyboard actions
computer-cli desktop click 640 360 --button left
computer-cli desktop double-click 640 360
computer-cli desktop right-click 640 360
computer-cli desktop move 500 300
computer-cli desktop drag 200 200 600 400
computer-cli desktop scroll down 5 --x 640 --y 400
computer-cli desktop type "Hello world"
computer-cli desktop key "ctrl+l"
computer-cli desktop key "Return"

# Clipboard and screen utilities
computer-cli desktop clipboard-write "https://github.com"
computer-cli desktop clipboard-read
computer-cli desktop cursor
computer-cli desktop screen-size
```

---

## 3. Mode B: Using MCP Tools (`computer_*`)

When the `computer-agent` MCP server is active, call these tools directly:

- `computer_status`: Check active connection state, `computerd` health, X11 display status, and `noVncUrl`.
- `computer_connect`: Switch target (`mode: "docker" | "tailscale" | "url" | "local"`, `peer`, `url`, `port`, `secret`).
- `computer_tailscale_peers`: Discover Tailscale peers (`probe: true` checks `/health` on every online Tailnet node).
- `computer_exec`: Execute shell commands inside the container (`command`, `cwd`).
- `computer_fs`: Perform `ls`, `read`, `write`, `find`, `grep`, `sync_push`, or `sync_pull`.
- `computer_git`: Run `init`, `status`, `diff`, `log`, `add`, or `commit`.
- `computer_desktop`: Perform GUI actions (`status`, `screenshot`, `click`, `double_click`, `triple_click`, `right_click`, `move`, `drag`, `scroll`, `type`, `key`, `windows`, `focus_window`, `cursor_position`, `screen_size`, `clipboard_read`, `clipboard_write`, `wait`, `open_url`).

---

## 4. Best Practices for Agent Workflows

1. **Always check status first**: Run `computer_status` (or `computer-cli status`) before starting a workflow to verify the active target and obtain the `noVncUrl` (`http://<host>:6080/vnc.html?autoconnect=true&resize=scale`) to share with the user.
2. **Closed-loop visual verification**: After GUI actions (`open_url`, `click`, `scroll`, `type`, `key`), wait briefly (`wait` 1000ms) and capture a `screenshot` to confirm the visual state.
3. **Remote Tailscale nodes**: When the user asks to connect to a remote machine on their Tailnet, run `computer_tailscale_peers` (or `computer-cli tailscale peers --probe`) first so you can show the discovered hostname, Tailscale IP (`100.x.y.z`), and live `noVncUrl`.
