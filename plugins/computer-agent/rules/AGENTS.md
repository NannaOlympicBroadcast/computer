# Computer Agent Plugin Rules (`@cloudflare/computer`)

When working with `@cloudflare/computer` cloud desktops, sandboxed containers, or remote Tailscale `computerd` nodes:

1. **Dual Invocation Support (MCP + Direct CLI)**:
   - If the `computer-agent` MCP server tools (`computer_status`, `computer_connect`, `computer_tailscale_peers`, `computer_exec`, `computer_fs`, `computer_git`, `computer_desktop`) are available in your toolset, prefer calling them directly.
   - If MCP tools are unavailable, disabled, or inconvenient in the current environment, immediately use the standalone CLI via shell execution:
     - `computer-cli <subcommand>` (if installed in `PATH` / `~/.local/bin/computer-cli`)
     - or `node <repo>/plugins/computer-agent/bin/computer-cli.mjs <subcommand>`
2. **Tailscale Virtual LAN Support**:
   - Use `computer_tailscale_peers` or `computer-cli tailscale peers --probe` to discover remote `computerd` instances across the user's Tailscale Tailnet.
   - Use `computer_connect` (`mode: "tailscale"`, `peer: "<hostname-or-ip>"`) or `computer-cli connect tailscale <hostname-or-ip>` to switch the active workspace target to a remote Tailscale node.
3. **Live Visual Feedback**:
   - Always surface the `noVncUrl` (`http://<host>:6080/vnc.html?autoconnect=true&resize=scale`) so the user can watch the X11 desktop live in their browser.
