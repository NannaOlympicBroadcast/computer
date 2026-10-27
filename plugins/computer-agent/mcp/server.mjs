#!/usr/bin/env node
// Model Context Protocol (MCP) stdio server for @cloudflare/computer.
// Works seamlessly across:
//   - Google Antigravity (mcp_config.json)
//   - Anthropic Claude Code (.mcp.json / mcp.json)
//   - OpenAI ChatGPT Codex CLI (.codex/config.toml)
//
// Shares persistent connection state (~/.computer-agent/state.json) with
// plugins/computer-agent/bin/computer-cli.mjs, supporting local Docker desktop,
// direct HTTP/WebSocket URLs, and Tailscale remote/virtual-LAN nodes.

import fs from "node:fs/promises";
import path from "node:path";
import {
  ensureDockerDesktopContainer,
  loadComputerSdk,
  loadConnectionState,
  loadMcpSdk,
  saveConnectionState,
  withWorkspace,
} from "../lib/runtime.mjs";

const TOOLS = [
  {
    name: "computer_status",
    description:
      "Inspect the active @cloudflare/computer connection state (url, tailscale, docker, or local mode), check computerd health, and query X11 GUI desktop status and noVNC preview URL.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "computer_connect",
    description:
      "Configure or switch the active @cloudflare/computer target instance. Supports starting/connecting a local Docker desktop container (`mode: 'docker'`), connecting to a remote/virtual-LAN computerd node over Tailscale (`mode: 'tailscale'`), connecting to a direct URL (`mode: 'url'`), or using pure local SQLite storage (`mode: 'local'`).",
    inputSchema: {
      type: "object",
      properties: {
        mode: {
          type: "string",
          enum: ["docker", "tailscale", "url", "local"],
          description: "Target connection mode.",
        },
        url: {
          type: "string",
          description:
            "Target computerd HTTP URL when mode='url' (e.g. 'http://127.0.0.1:8080' or 'http://100.64.0.5:8080').",
        },
        peer: {
          type: "string",
          description:
            "Tailscale hostname, MagicDNS FQDN, or Tailscale IP (100.x.y.z) when mode='tailscale'. Omit to auto-discover the first online Tailnet node running computerd.",
        },
        port: {
          type: "number",
          description: "computerd HTTP/RPC port (default: 8080).",
        },
        noVncPort: {
          type: "number",
          description: "noVNC web desktop port (default: 6080).",
        },
        secret: {
          type: "string",
          description: "RPC_CLIENT_SECRET bearer token (default: 'local-dev-secret').",
        },
        resolution: {
          type: "string",
          description: "Xvfb resolution when mode='docker' (default: '1280x720x24').",
        },
        preferMagicDns: {
          type: "boolean",
          description:
            "Use Tailscale MagicDNS hostname instead of 100.x.y.z IPv4 when mode='tailscale'.",
        },
      },
      required: ["mode"],
    },
  },
  {
    name: "computer_tailscale_peers",
    description:
      "List Tailscale Tailnet peers and optionally probe each online node's /health endpoint to discover remote or virtual-LAN computerd instances and their noVNC URLs.",
    inputSchema: {
      type: "object",
      properties: {
        probe: {
          type: "boolean",
          description:
            "Probe http://<peer>:<port>/health on each online Tailnet peer (default: true).",
        },
        port: {
          type: "number",
          description: "computerd port to probe (default: 8080).",
        },
        noVncPort: {
          type: "number",
          description: "noVNC web port (default: 6080).",
        },
        includeOffline: {
          type: "boolean",
          description: "Include offline Tailnet peers in the list (default: false).",
        },
      },
    },
  },
  {
    name: "computer_exec",
    description:
      "Execute a shell command inside the connected computerd container/instance via capnweb RPC and return exitCode, stdout, and stderr.",
    inputSchema: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "Shell command to run via /bin/sh -c.",
        },
        cwd: {
          type: "string",
          description: "Working directory inside the container (default: '/workspace').",
        },
      },
      required: ["command"],
    },
  },
  {
    name: "computer_fs",
    description:
      "Read, write, list, find, or grep files in the persistent Workspace virtual filesystem, or sync between the local SQLite VFS and the remote computerd FUSE mount.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["ls", "read", "write", "find", "grep", "sync_push", "sync_pull"],
          description: "Filesystem or sync operation.",
        },
        path: {
          type: "string",
          description: "File or directory path (default: '/workspace').",
        },
        content: {
          type: "string",
          description: "UTF-8 file content to write when action='write'.",
        },
        pattern: {
          type: "string",
          description: "Glob or regex pattern when action='find' or action='grep'.",
        },
        recursive: {
          type: "boolean",
          description: "List directories recursively when action='ls'.",
        },
      },
      required: ["action"],
    },
  },
  {
    name: "computer_git",
    description:
      "Run built-in Git version control operations (init, status, diff, log, add, commit) against the Workspace filesystem.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["init", "status", "diff", "log", "add", "commit"],
          description: "Git operation.",
        },
        dir: {
          type: "string",
          description: "Repository directory in Workspace (default: '/workspace').",
        },
        paths: {
          type: "array",
          items: { type: "string" },
          description: "File paths to stage when action='add' (default: ['.']).",
        },
        message: {
          type: "string",
          description: "Commit message when action='commit'.",
        },
        authorName: {
          type: "string",
          description: "Commit author name (default: 'Computer Agent').",
        },
        authorEmail: {
          type: "string",
          description: "Commit author email (default: 'agent@cloudflare.com').",
        },
      },
      required: ["action"],
    },
  },
  {
    name: "computer_desktop",
    description:
      "Control the X11 GUI desktop inside the computerd container: take screenshots (returned as native MCP images), click/move/drag/scroll the mouse, type text, press key combos, list/focus X11 windows, read/write clipboard, or launch a URL in Chromium.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: [
            "status",
            "screenshot",
            "click",
            "double_click",
            "triple_click",
            "right_click",
            "move",
            "drag",
            "scroll",
            "type",
            "key",
            "windows",
            "focus_window",
            "cursor_position",
            "screen_size",
            "clipboard_read",
            "clipboard_write",
            "wait",
            "open_url",
          ],
          description: "Desktop GUI action to perform.",
        },
        x: { type: "number", description: "Target X coordinate in pixels." },
        y: { type: "number", description: "Target Y coordinate in pixels." },
        fromX: { type: "number", description: "Drag start X coordinate." },
        fromY: { type: "number", description: "Drag start Y coordinate." },
        toX: { type: "number", description: "Drag end X coordinate." },
        toY: { type: "number", description: "Drag end Y coordinate." },
        button: {
          type: "string",
          enum: ["left", "middle", "right"],
          description: "Mouse button for click.",
        },
        direction: {
          type: "string",
          enum: ["up", "down", "left", "right"],
          description: "Scroll direction.",
        },
        ticks: {
          type: "number",
          description: "Number of scroll wheel ticks (default: 4).",
        },
        text: {
          type: "string",
          description: "Text to type, window title/ID to focus, clipboard content, or URL to open.",
        },
        key: {
          type: "string",
          description: "Key or key chord (e.g. 'Return', 'ctrl+l', 'alt+F4', 'Page_Down').",
        },
        delayMs: {
          type: "number",
          description: "Duration in milliseconds for wait or typing delay.",
        },
        outputPath: {
          type: "string",
          description: "Optional host file path to also save the PNG screenshot to disk.",
        },
      },
      required: ["action"],
    },
  },
];

function jsonResponse(payload) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(payload, null, 2),
      },
    ],
  };
}

async function handleToolCall(name, args = {}) {
  switch (name) {
    case "computer_status": {
      const state = await loadConnectionState();
      if (state.mode === "local") {
        return jsonResponse({
          mode: "local",
          state,
          healthy: true,
        });
      }
      try {
        const info = await withWorkspace(async (ws, currentState) => {
          const desktopStatus = await ws.desktop.status().catch((err) => ({
            available: false,
            error: err.message,
          }));
          return {
            mode: currentState.mode,
            healthy: true,
            state: currentState,
            desktop: desktopStatus,
          };
        }, state);
        return jsonResponse(info);
      } catch (err) {
        return jsonResponse({
          mode: state.mode,
          healthy: false,
          state,
          error: err.message,
        });
      }
    }

    case "computer_connect": {
      const mode = args.mode;
      if (mode === "docker") {
        const next = await ensureDockerDesktopContainer({
          port: args.port ?? 8080,
          noVncPort: args.noVncPort ?? 6080,
          resolution: args.resolution ?? "1280x720x24",
          secret: args.secret ?? "local-dev-secret",
        });
        return jsonResponse({ connected: true, state: next });
      }
      if (mode === "tailscale") {
        const sdk = await loadComputerSdk();
        const port = args.port ?? 8080;
        const noVncPort = args.noVncPort ?? 6080;
        const secret = args.secret ?? "local-dev-secret";
        const resolved = await sdk.resolveTailscaleTarget({
          peer: args.peer,
          port,
          noVncPort,
          preferMagicDns: Boolean(args.preferMagicDns),
        });
        const next = await saveConnectionState({
          mode: "tailscale",
          tailscalePeer: args.peer ?? resolved.host,
          tailscalePort: port,
          url: resolved.url,
          noVncUrl: resolved.noVncUrl,
          vncAddress: `${resolved.host}:5900`,
          secret,
          preferMagicDns: Boolean(args.preferMagicDns),
        });
        return jsonResponse({
          connected: true,
          resolvedPeer: resolved.peer,
          state: next,
        });
      }
      if (mode === "url") {
        const url = args.url ?? "http://127.0.0.1:8080";
        const secret = args.secret ?? "local-dev-secret";
        const parsed = new URL(url);
        const noVncPort = args.noVncPort ?? 6080;
        const next = await saveConnectionState({
          mode: "url",
          url: url.replace(/\/$/, ""),
          secret,
          noVncUrl: `${parsed.protocol}//${parsed.hostname}:${noVncPort}/vnc.html?autoconnect=true&resize=scale`,
          vncAddress: `${parsed.hostname}:5900`,
        });
        return jsonResponse({ connected: true, state: next });
      }
      if (mode === "local") {
        const next = await saveConnectionState({ mode: "local" });
        return jsonResponse({ connected: true, state: next });
      }
      throw new Error(`Unsupported mode: ${mode}`);
    }

    case "computer_tailscale_peers": {
      const sdk = await loadComputerSdk();
      const port = args.port ?? 8080;
      const peers = await sdk.discoverTailscalePeers({
        includeOffline: Boolean(args.includeOffline),
        probeComputerdPort: args.probe === false ? undefined : port,
        noVncPort: args.noVncPort ?? 6080,
      });
      return jsonResponse({ count: peers.length, peers });
    }

    case "computer_exec": {
      return await withWorkspace(async (ws) => {
        const handle = await ws.runtime.exec(args.command, {
          cwd: args.cwd ?? "/workspace",
          encoding: "utf8",
        });
        const res = await handle.result();
        return jsonResponse(res);
      });
    }

    case "computer_fs": {
      return await withWorkspace(async (ws) => {
        const action = args.action;
        const targetPath = args.path ?? "/workspace";
        if (action === "ls") {
          try {
            for await (const _ of ws.pull()) {
              // best-effort pull before listing
            }
          } catch {
            // ignore pull error in local mode
          }
          const entries = await ws.fs.ls(targetPath, {
            recursive: Boolean(args.recursive),
          });
          return jsonResponse({ path: targetPath, entries });
        }
        if (action === "read") {
          try {
            for await (const _ of ws.pull()) {
              // best-effort pull before reading
            }
          } catch {
            // ignore pull error in local mode
          }
          const content = await ws.fs.readFile(targetPath, "utf8");
          return jsonResponse({ path: targetPath, content });
        }
        if (action === "write") {
          const dir = path.posix.dirname(targetPath);
          if (dir && dir !== "/") {
            await ws.fs.mkdir(dir, { recursive: true });
          }
          await ws.fs.writeFile(targetPath, args.content ?? "");
          try {
            for await (const _ of ws.push()) {
              // best-effort push after write
            }
          } catch {
            // ignore push error in local mode
          }
          return jsonResponse({
            path: targetPath,
            bytesWritten: Buffer.byteLength(args.content ?? "", "utf8"),
          });
        }
        if (action === "find") {
          const matches = await ws.fs.find({
            path: targetPath,
            name: args.pattern ?? "*",
          });
          return jsonResponse({ pattern: args.pattern ?? "*", matches });
        }
        if (action === "grep") {
          const matches = await ws.fs.grep({
            path: targetPath,
            pattern: args.pattern ?? "",
          });
          return jsonResponse({ pattern: args.pattern ?? "", matches });
        }
        if (action === "sync_push") {
          let pushedEvents = 0;
          for await (const _ of ws.push()) pushedEvents++;
          return jsonResponse({ synced: "push", pushedEvents });
        }
        if (action === "sync_pull") {
          let pulledEvents = 0;
          for await (const _ of ws.pull()) pulledEvents++;
          return jsonResponse({ synced: "pull", pulledEvents });
        }
        throw new Error(`Unsupported fs action: ${action}`);
      });
    }

    case "computer_git": {
      return await withWorkspace(async (ws) => {
        const dir = args.dir ?? "/workspace";
        switch (args.action) {
          case "init":
            await ws.git.init(dir);
            return jsonResponse({ initialized: true, dir });
          case "status":
            return jsonResponse({ status: await ws.git.status(dir) });
          case "diff":
            return jsonResponse({ diff: await ws.git.diff(dir) });
          case "log":
            return jsonResponse({ log: await ws.git.log(dir, { depth: 10 }) });
          case "add":
            await ws.git.add(dir, args.paths ?? ["."]);
            return jsonResponse({ staged: args.paths ?? ["."] });
          case "commit": {
            const sha = await ws.git.commit(dir, {
              message: args.message ?? "Update via computer_git",
              author: {
                name: args.authorName ?? "Computer Agent",
                email: args.authorEmail ?? "agent@cloudflare.com",
              },
            });
            return jsonResponse({ sha });
          }
          default:
            throw new Error(`Unsupported git action: ${args.action}`);
        }
      });
    }

    case "computer_desktop": {
      return await withWorkspace(async (ws, state) => {
        const action = args.action;
        switch (action) {
          case "status": {
            const status = await ws.desktop.status();
            return jsonResponse({
              ...status,
              noVncUrl: state.noVncUrl,
              vncAddress: state.vncAddress,
            });
          }
          case "screenshot": {
            const shot = await ws.desktop.screenshot({ format: "png" });
            const base64 = Buffer.from(shot.data).toString("base64");
            let savedTo = null;
            if (args.outputPath) {
              savedTo = path.resolve(args.outputPath);
              await fs.mkdir(path.dirname(savedTo), { recursive: true });
              await fs.writeFile(savedTo, Buffer.from(shot.data));
            }
            return {
              content: [
                {
                  type: "image",
                  data: base64,
                  mimeType: shot.mimeType,
                },
                {
                  type: "text",
                  text: JSON.stringify(
                    {
                      width: shot.width,
                      height: shot.height,
                      mimeType: shot.mimeType,
                      byteLength: shot.data.byteLength,
                      savedTo,
                      noVncUrl: state.noVncUrl,
                    },
                    null,
                    2,
                  ),
                },
              ],
            };
          }
          case "click":
            await ws.desktop.click({
              x: args.x ?? 0,
              y: args.y ?? 0,
              button: args.button ?? "left",
            });
            return jsonResponse({ action: "click", x: args.x ?? 0, y: args.y ?? 0 });
          case "double_click":
            await ws.desktop.doubleClick({
              x: args.x ?? 0,
              y: args.y ?? 0,
              button: args.button ?? "left",
            });
            return jsonResponse({ action: "double_click", x: args.x ?? 0, y: args.y ?? 0 });
          case "triple_click":
            await ws.desktop.tripleClick({
              x: args.x ?? 0,
              y: args.y ?? 0,
              button: args.button ?? "left",
            });
            return jsonResponse({ action: "triple_click", x: args.x ?? 0, y: args.y ?? 0 });
          case "right_click":
            await ws.desktop.rightClick({ x: args.x ?? 0, y: args.y ?? 0 });
            return jsonResponse({ action: "right_click", x: args.x ?? 0, y: args.y ?? 0 });
          case "move":
            await ws.desktop.move({ x: args.x ?? 0, y: args.y ?? 0 });
            return jsonResponse({ action: "move", x: args.x ?? 0, y: args.y ?? 0 });
          case "drag":
            await ws.desktop.drag({
              startX: args.fromX ?? 0,
              startY: args.fromY ?? 0,
              endX: args.toX ?? 0,
              endY: args.toY ?? 0,
              button: args.button ?? "left",
            });
            return jsonResponse({
              action: "drag",
              from: { x: args.fromX ?? 0, y: args.fromY ?? 0 },
              to: { x: args.toX ?? 0, y: args.toY ?? 0 },
            });
          case "scroll":
            await ws.desktop.scroll({
              direction: args.direction ?? "down",
              amount: args.ticks ?? 4,
              ...(args.x !== undefined && args.y !== undefined ? { x: args.x, y: args.y } : {}),
            });
            return jsonResponse({
              action: "scroll",
              direction: args.direction ?? "down",
              ticks: args.ticks ?? 4,
            });
          case "type":
            await ws.desktop.type({ text: args.text ?? "", delayMs: args.delayMs ?? 12 });
            return jsonResponse({ action: "type", textLength: (args.text ?? "").length });
          case "key":
            await ws.desktop.key(args.key ?? "Return");
            return jsonResponse({ action: "key", key: args.key ?? "Return" });
          case "windows":
            return jsonResponse({ windows: await ws.desktop.windows() });
          case "focus_window": {
            const target = args.text ?? "";
            if (/^0x[0-9a-f]+$/i.test(target) || /^\d+$/.test(target)) {
              await ws.desktop.focusWindow({ id: target });
            } else {
              await ws.desktop.focusWindow({ title: target });
            }
            return jsonResponse({ action: "focus_window", target });
          }
          case "cursor_position":
            return jsonResponse(await ws.desktop.cursorPosition());
          case "screen_size":
            return jsonResponse(await ws.desktop.screenSize());
          case "clipboard_read":
            return jsonResponse({ text: await ws.desktop.clipboardRead() });
          case "clipboard_write":
            await ws.desktop.clipboardWrite(args.text ?? "");
            return jsonResponse({ written: true, length: (args.text ?? "").length });
          case "wait":
            await ws.desktop.wait(args.delayMs ?? 1000);
            return jsonResponse({ waitedMs: args.delayMs ?? 1000 });
          case "open_url": {
            const url = args.text ?? "https://example.com";
            const handle = await ws.runtime.exec(
              `nohup chromium --no-sandbox --disable-dev-shm-usage --no-first-run --no-default-browser-check --window-position=0,0 --window-size=1280,695 ${JSON.stringify(url)} >/dev/null 2>&1 &`,
              { encoding: "utf8" },
            );
            await handle.result();
            await ws.desktop.wait(1500);
            return jsonResponse({ openedUrl: url, noVncUrl: state.noVncUrl });
          }
          default:
            throw new Error(`Unsupported desktop action: ${action}`);
        }
      });
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

async function main() {
  const { Server, StdioServerTransport, ListToolsRequestSchema, CallToolRequestSchema } =
    await loadMcpSdk();

  const server = new Server(
    {
      name: "computer-agent",
      version: "0.1.0",
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      return await handleToolCall(request.params.name, request.params.arguments ?? {});
    } catch (err) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                ok: false,
                error: err instanceof Error ? err.message : String(err),
              },
              null,
              2,
            ),
          },
        ],
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`computer-agent MCP server fatal error: ${err.stack || err.message}\n`);
  process.exit(1);
});
