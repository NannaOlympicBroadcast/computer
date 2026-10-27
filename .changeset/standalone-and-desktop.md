---
"@cloudflare/computer": minor
"@cloudflare/computerd": minor
"@cloudflare/computer-rpc": minor
---

Run `Workspace` outside Cloudflare Workers on `node:sqlite` (`NodeSQLiteStorage`) with direct `computerd` and Docker backends (`ComputerdBackend` and `DockerContainerBackend` under `@cloudflare/computer/backends/computerd`), and add X11 desktop container and GUI automation support across `computerd` (`Dockerfile.desktop`, `DesktopController`), `workspace.desktop`, and the AI SDK, Pi, and TanStack agent tool sets (`createDesktopTool` and `desktop: true`).
