---
description: Check status, connect, or run commands on the active @cloudflare/computer instance (Docker, URL, or Tailscale).
---

Inspect or control the `@cloudflare/computer` workspace requested by the user: `$ARGUMENTS`

1. First check the active connection status using the `computer_status` MCP tool, or run `computer-cli status` if MCP tools are unavailable.
2. Execute the requested shell, filesystem, git, or desktop operation and report the result along with the `noVncUrl` if a desktop container is active.
