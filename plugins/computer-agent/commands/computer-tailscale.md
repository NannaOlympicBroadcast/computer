---
description: Discover and connect to remote @cloudflare/computer instances over Tailscale Tailnet.
---

Discover or connect to a Tailscale remote `computerd` instance: `$ARGUMENTS`

1. Run `computer_tailscale_peers` (`probe: true`) or `computer-cli tailscale peers --probe` to scan online Tailnet nodes for running `computerd` servers.
2. Connect to the target peer using `computer_connect` (`mode: "tailscale"`, `peer: "$ARGUMENTS"`) or `computer-cli connect tailscale $ARGUMENTS`.
3. Verify health and desktop availability and report the remote Tailscale IP, MagicDNS name, and `noVncUrl`.
