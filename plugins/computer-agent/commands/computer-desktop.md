---
description: Automate the X11 GUI desktop and Chromium browser inside @cloudflare/computer and capture a screenshot.
---

Perform the following GUI desktop task on the active `@cloudflare/computer` desktop: `$ARGUMENTS`

1. Verify desktop availability via `computer_desktop` (`action: "status"`) or `computer-cli desktop status`.
2. Execute the requested GUI actions (`open_url`, `click`, `scroll`, `type`, `key`, `focus_window`).
3. Capture a final screenshot (`computer_desktop` with `action: "screenshot"` or `computer-cli desktop screenshot --output ./desktop-latest.png`) and provide the live `noVncUrl` (`http://<host>:6080/vnc.html?autoconnect=true&resize=scale`) to the user.
