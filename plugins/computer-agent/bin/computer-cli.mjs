#!/usr/bin/env node
// computer-cli: Direct CLI for @cloudflare/computer (Workspace + Docker + Tailscale + Desktop GUI).
// Designed for AI agents (Antigravity, Claude Code, OpenAI Codex CLI) and developers
// in environments where MCP tools are unavailable or where shell commands are preferred.

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  ensureDockerDesktopContainer,
  loadComputerSdk,
  loadConnectionState,
  runDockerCmd,
  saveConnectionState,
  withWorkspace,
} from "../lib/runtime.mjs";

function parseArgs(argv) {
  const positionals = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token.startsWith("--")) {
      const eqIdx = token.indexOf("=");
      if (eqIdx !== -1) {
        flags[token.slice(2, eqIdx)] = token.slice(eqIdx + 1);
      } else {
        const key = token.slice(2);
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("--")) {
          flags[key] = next;
          i++;
        } else {
          flags[key] = true;
        }
      }
    } else {
      positionals.push(token);
    }
  }
  return { positionals, flags };
}

function outputSuccess(command, data) {
  process.stdout.write(`${JSON.stringify({ ok: true, command, data }, null, 2)}\n`);
}

function outputError(command, error, hint) {
  const message = error instanceof Error ? error.message : String(error);
  process.stdout.write(
    `${JSON.stringify({ ok: false, command, error: message, ...(hint ? { hint } : {}) }, null, 2)}\n`,
  );
  process.exitCode = 1;
}

const HELP_TEXT = {
  usage: "node bin/computer-cli.mjs <group> [subcommand] [args] [--flags]",
  groups: {
    status: "Inspect current connection profile, computerd health, FUSE mount, and desktop status",
    "connect docker":
      "Start/attach local Docker desktop container (--name, --image, --port, --novnc-port, --vnc-port, --resolution, --secret)",
    "connect url <url>":
      "Connect to a local/LAN/remote computerd HTTP endpoint (--secret, --novnc-port)",
    "connect tailscale [peer]":
      "Connect to a Tailscale Tailnet peer by hostname, MagicDNS, IP, or auto-discover (--port, --novnc-port, --secret, --magic-dns)",
    "connect local": "Use local SQLite Workspace only without a container (--storage)",
    "tailscale peers":
      "List Tailscale Tailnet nodes and optionally probe for running computerd instances (--probe, --port, --all)",
    "exec <cmd>": "Execute a shell command in the connected container (--cwd)",
    "fs <ls|read|write|find|grep>":
      "Read, write, list, search files in the synced SQLite/FUSE workspace",
    "sync <push|pull>":
      "Explicitly push host SQLite changes to container or pull container changes",
    "git <status|diff|log|init|add|commit>": "Run built-in Git operations on /workspace",
    "desktop <status|screenshot|click|move|drag|scroll|type|key|windows|focus|cursor|screen-size|clipboard-read|clipboard-write|wait|open-url>":
      "Drive the X11 GUI desktop and capture screenshots",
  },
};

async function main() {
  const { positionals, flags } = parseArgs(process.argv.slice(2));
  const [group, sub, ...rest] = positionals;

  if (!group || group === "help" || flags.help) {
    outputSuccess("help", HELP_TEXT);
    return;
  }

  const cmdLabel = [group, sub].filter(Boolean).join(" ");

  try {
    if (group === "status") {
      const state = await loadConnectionState();
      if (state.mode === "local") {
        outputSuccess("status", { state, backend: "local-sqlite-only" });
        return;
      }
      await withWorkspace(async (ws, activeState) => {
        let desktopStatus = null;
        try {
          desktopStatus = await ws.desktop.status();
        } catch (err) {
          desktopStatus = { error: err instanceof Error ? err.message : String(err) };
        }
        outputSuccess("status", {
          state: activeState,
          desktop: desktopStatus,
        });
      });
      return;
    }

    if (group === "tailscale") {
      const sdk = await loadComputerSdk();
      if (!sub || sub === "peers" || sub === "status") {
        const probePort =
          flags.probe !== undefined
            ? typeof flags.probe === "string"
              ? Number.parseInt(flags.probe, 10)
              : Number.parseInt(String(flags.port ?? "8080"), 10)
            : undefined;
        const peers = await sdk.discoverTailscalePeers({
          includeOffline: Boolean(flags.all),
          probeComputerdPort: probePort,
          noVncPort: flags["novnc-port"] ? Number.parseInt(String(flags["novnc-port"]), 10) : 6080,
        });
        outputSuccess("tailscale peers", { count: peers.length, peers });
        return;
      }
      if (sub === "resolve") {
        const peer = rest[0] ?? (typeof flags.peer === "string" ? flags.peer : undefined);
        const resolved = await sdk.resolveTailscaleTarget({
          peer,
          port: flags.port ? Number.parseInt(String(flags.port), 10) : 8080,
          noVncPort: flags["novnc-port"] ? Number.parseInt(String(flags["novnc-port"]), 10) : 6080,
          preferMagicDns: Boolean(flags["magic-dns"]),
        });
        outputSuccess("tailscale resolve", resolved);
        return;
      }
      throw new Error(`Unknown tailscale subcommand: ${sub}`);
    }

    if (group === "connect") {
      if (sub === "docker") {
        const state = await ensureDockerDesktopContainer({
          name: typeof flags.name === "string" ? flags.name : undefined,
          image: typeof flags.image === "string" ? flags.image : undefined,
          port: flags.port ? Number.parseInt(String(flags.port), 10) : 8080,
          noVncPort: flags["novnc-port"] ? Number.parseInt(String(flags["novnc-port"]), 10) : 6080,
          vncPort: flags["vnc-port"] ? Number.parseInt(String(flags["vnc-port"]), 10) : 5900,
          resolution: typeof flags.resolution === "string" ? flags.resolution : "1280x720x24",
          secret: typeof flags.secret === "string" ? flags.secret : "local-dev-secret",
        });
        outputSuccess("connect docker", state);
        return;
      }
      if (sub === "url") {
        const url = rest[0] ?? (typeof flags.url === "string" ? flags.url : undefined);
        if (!url)
          throw new Error("Usage: computer-cli connect url <http://host:8080> [--secret s]");
        const parsed = new URL(url);
        const noVncPort = flags["novnc-port"]
          ? Number.parseInt(String(flags["novnc-port"]), 10)
          : 6080;
        const noVncUrl = `${parsed.protocol}//${parsed.hostname}:${noVncPort}/vnc.html?autoconnect=true&resize=scale`;
        const state = await saveConnectionState({
          mode: "url",
          url: url.replace(/\/+$/, ""),
          secret: typeof flags.secret === "string" ? flags.secret : "",
          noVncUrl,
          ...(typeof flags.storage === "string" ? { storage: path.resolve(flags.storage) } : {}),
        });
        outputSuccess("connect url", state);
        return;
      }
      if (sub === "tailscale") {
        const peer = rest[0] ?? (typeof flags.peer === "string" ? flags.peer : undefined);
        const port = flags.port ? Number.parseInt(String(flags.port), 10) : 8080;
        const noVncPort = flags["novnc-port"]
          ? Number.parseInt(String(flags["novnc-port"]), 10)
          : 6080;
        const preferMagicDns = Boolean(flags["magic-dns"]);
        const sdk = await loadComputerSdk();
        const resolved = await sdk.resolveTailscaleTarget({
          peer,
          port,
          noVncPort,
          preferMagicDns,
        });
        const state = await saveConnectionState({
          mode: "tailscale",
          tailscalePeer: peer ?? resolved.host,
          tailscalePort: port,
          noVncPort,
          preferMagicDns,
          url: resolved.url,
          noVncUrl: resolved.noVncUrl,
          ...(typeof flags.secret === "string" ? { secret: flags.secret } : {}),
          ...(typeof flags.storage === "string" ? { storage: path.resolve(flags.storage) } : {}),
        });
        outputSuccess("connect tailscale", { state, resolved });
        return;
      }
      if (sub === "local") {
        const state = await saveConnectionState({
          mode: "local",
          ...(typeof flags.storage === "string" ? { storage: path.resolve(flags.storage) } : {}),
        });
        outputSuccess("connect local", state);
        return;
      }
      throw new Error(`Unknown connect target: ${sub}. Expected docker, url, tailscale, or local.`);
    }

    if (group === "docker") {
      if (sub === "stop") {
        const state = await loadConnectionState();
        const name =
          typeof flags.name === "string"
            ? flags.name
            : (state.dockerContainer ?? "computer-desktop-demo");
        await runDockerCmd(["rm", "-f", name]);
        outputSuccess("docker stop", { removed: name });
        return;
      }
      throw new Error(`Unknown docker subcommand: ${sub}`);
    }

    if (group === "exec") {
      const commandStr = [sub, ...rest].filter(Boolean).join(" ");
      if (!commandStr)
        throw new Error('Usage: computer-cli exec "<shell command>" [--cwd /workspace]');
      await withWorkspace(async (ws) => {
        const handle = await ws.runtime.exec(commandStr, {
          cwd: typeof flags.cwd === "string" ? flags.cwd : "/workspace",
          encoding: "utf8",
        });
        const res = await handle.result();
        outputSuccess("exec", res);
      });
      return;
    }

    if (group === "sync") {
      await withWorkspace(async (ws) => {
        if (sub === "push") {
          let events = 0;
          for await (const _ of ws.push()) events++;
          outputSuccess("sync push", { pushedEvents: events });
          return;
        }
        if (sub === "pull") {
          let events = 0;
          for await (const _ of ws.pull()) events++;
          outputSuccess("sync pull", { pulledEvents: events });
          return;
        }
        throw new Error("Usage: computer-cli sync <push|pull>");
      });
      return;
    }

    if (group === "fs") {
      await withWorkspace(async (ws) => {
        if (sub === "ls") {
          try {
            for await (const _ of ws.pull()) {
              // sync from container before listing
            }
          } catch {
            // ignore pull error in local mode
          }
          const targetPath = rest[0] ?? "/workspace";
          const entries = await ws.fs.ls(targetPath, {
            recursive: Boolean(flags.recursive || flags.r),
          });
          outputSuccess("fs ls", { path: targetPath, entries });
          return;
        }
        if (sub === "read") {
          const targetPath = rest[0];
          if (!targetPath) throw new Error("Usage: computer-cli fs read <path> [--out local-file]");
          try {
            for await (const _ of ws.pull()) {
              // best-effort pull before read
            }
          } catch {
            // ignore pull error in local mode
          }
          if (typeof flags.out === "string") {
            const bytes = await ws.fs.readFile(targetPath);
            const outPath = path.resolve(flags.out);
            await fs.mkdir(path.dirname(outPath), { recursive: true });
            await fs.writeFile(outPath, bytes);
            outputSuccess("fs read", { path: targetPath, out: outPath, bytes: bytes.byteLength });
          } else {
            const content = await ws.fs.readFile(targetPath, "utf8");
            outputSuccess("fs read", { path: targetPath, content });
          }
          return;
        }
        if (sub === "write") {
          const targetPath = rest[0];
          if (!targetPath) {
            throw new Error("Usage: computer-cli fs write <path> [content] [--in local-file]");
          }
          const dir = path.posix.dirname(targetPath);
          if (dir && dir !== "/") {
            await ws.fs.mkdir(dir, { recursive: true });
          }
          let payload;
          if (typeof flags.in === "string") {
            payload = new Uint8Array(await fs.readFile(path.resolve(flags.in)));
          } else {
            payload = rest.slice(1).join(" ");
          }
          await ws.fs.writeFile(targetPath, payload);
          try {
            for await (const _ of ws.push()) {
              // best-effort push after write
            }
          } catch {
            // ignore push error in local mode
          }
          outputSuccess("fs write", {
            path: targetPath,
            bytes: typeof payload === "string" ? Buffer.byteLength(payload) : payload.byteLength,
          });
          return;
        }
        if (sub === "find") {
          const pattern = rest[0] ?? "*";
          const basePath = typeof flags.path === "string" ? flags.path : "/workspace";
          const res = await ws.fs.find({ path: basePath, name: pattern });
          outputSuccess("fs find", res);
          return;
        }
        if (sub === "grep") {
          const pattern = rest[0];
          if (!pattern)
            throw new Error("Usage: computer-cli fs grep <pattern> [--path /workspace]");
          const basePath = typeof flags.path === "string" ? flags.path : "/workspace";
          const res = await ws.fs.grep({ path: basePath, pattern });
          outputSuccess("fs grep", res);
          return;
        }
        throw new Error(`Unknown fs subcommand: ${sub}. Expected ls, read, write, find, or grep.`);
      });
      return;
    }

    if (group === "git") {
      const dir = typeof flags.dir === "string" ? flags.dir : "/workspace";
      await withWorkspace(async (ws) => {
        if (sub === "init") {
          await ws.git.init(dir);
          outputSuccess("git init", { dir });
          return;
        }
        if (sub === "status") {
          const status = await ws.git.status(dir);
          outputSuccess("git status", status);
          return;
        }
        if (sub === "diff") {
          const diff = await ws.git.diff(dir);
          outputSuccess("git diff", { diff });
          return;
        }
        if (sub === "log") {
          const log = await ws.git.log(dir, {
            depth: flags.limit ? Number.parseInt(String(flags.limit), 10) : 10,
          });
          outputSuccess("git log", log);
          return;
        }
        if (sub === "add") {
          const paths = rest.length > 0 ? rest : ["."];
          await ws.git.add(dir, paths);
          outputSuccess("git add", { dir, paths });
          return;
        }
        if (sub === "commit") {
          const message =
            rest.join(" ") || (typeof flags.message === "string" ? flags.message : "");
          if (!message) throw new Error('Usage: computer-cli git commit "<message>"');
          const sha = await ws.git.commit(dir, {
            message,
            author: {
              name: typeof flags.name === "string" ? flags.name : "Computer Agent",
              email: typeof flags.email === "string" ? flags.email : "agent@cloudflare.com",
            },
          });
          outputSuccess("git commit", { dir, sha, message });
          return;
        }
        throw new Error(`Unknown git subcommand: ${sub}`);
      });
      return;
    }

    if (group === "desktop") {
      await withWorkspace(async (ws, state) => {
        if (!sub || sub === "status") {
          const status = await ws.desktop.status();
          outputSuccess("desktop status", { ...status, noVncUrl: state.noVncUrl });
          return;
        }
        if (sub === "screenshot") {
          const format = flags.format === "jpeg" ? "jpeg" : "png";
          let region;
          if (typeof flags.region === "string") {
            const parts = flags.region.split(",").map((n) => Number.parseInt(n.trim(), 10));
            if (parts.length === 4 && parts.every((n) => Number.isFinite(n))) {
              region = { x: parts[0], y: parts[1], width: parts[2], height: parts[3] };
            }
          }
          const shot = await ws.desktop.screenshot({
            format,
            ...(region ? { region } : {}),
            ...(flags.quality ? { quality: Number.parseInt(String(flags.quality), 10) } : {}),
          });
          const outFile =
            typeof flags.out === "string"
              ? path.resolve(flags.out)
              : path.join(os.tmpdir(), `computer-desktop-${Date.now()}.${format}`);
          await fs.mkdir(path.dirname(outFile), { recursive: true });
          await fs.writeFile(outFile, shot.data);
          outputSuccess("desktop screenshot", {
            file: outFile,
            mimeType: shot.mimeType,
            width: shot.width,
            height: shot.height,
            bytes: shot.data.byteLength,
            ...(flags.base64 ? { base64: Buffer.from(shot.data).toString("base64") } : {}),
          });
          return;
        }
        if (
          sub === "click" ||
          sub === "double-click" ||
          sub === "triple-click" ||
          sub === "right-click"
        ) {
          const x =
            rest[0] !== undefined
              ? Number(rest[0])
              : flags.x !== undefined
                ? Number(flags.x)
                : undefined;
          const y =
            rest[1] !== undefined
              ? Number(rest[1])
              : flags.y !== undefined
                ? Number(flags.y)
                : undefined;
          const button =
            sub === "right-click"
              ? "right"
              : typeof flags.button === "string"
                ? flags.button
                : "left";
          const count =
            sub === "double-click"
              ? 2
              : sub === "triple-click"
                ? 3
                : flags.count
                  ? Number.parseInt(String(flags.count), 10)
                  : 1;
          const modifiers =
            typeof flags.modifiers === "string"
              ? flags.modifiers
                  .split(",")
                  .map((s) => s.trim())
                  .filter(Boolean)
              : undefined;
          await ws.desktop.click({
            ...(x !== undefined && y !== undefined ? { x, y } : {}),
            button,
            count,
            ...(modifiers ? { modifiers } : {}),
          });
          outputSuccess(`desktop ${sub}`, { x, y, button, count });
          return;
        }
        if (sub === "move") {
          const x = Number(rest[0] ?? flags.x);
          const y = Number(rest[1] ?? flags.y);
          await ws.desktop.move({ x, y, relative: Boolean(flags.relative) });
          outputSuccess("desktop move", { x, y, relative: Boolean(flags.relative) });
          return;
        }
        if (sub === "drag") {
          const startX = Number(rest[0] ?? flags.startX);
          const startY = Number(rest[1] ?? flags.startY);
          const endX = Number(rest[2] ?? flags.endX);
          const endY = Number(rest[3] ?? flags.endY);
          const steps = flags.steps ? Number.parseInt(String(flags.steps), 10) : 10;
          await ws.desktop.drag({ startX, startY, endX, endY, steps });
          outputSuccess("desktop drag", { startX, startY, endX, endY, steps });
          return;
        }
        if (sub === "scroll") {
          const direction =
            rest[0] ?? (typeof flags.direction === "string" ? flags.direction : "down");
          const amount = rest[1]
            ? Number.parseInt(rest[1], 10)
            : flags.amount
              ? Number.parseInt(String(flags.amount), 10)
              : 4;
          const x = flags.x !== undefined ? Number(flags.x) : undefined;
          const y = flags.y !== undefined ? Number(flags.y) : undefined;
          await ws.desktop.scroll({
            direction,
            amount,
            ...(x !== undefined && y !== undefined ? { x, y } : {}),
          });
          outputSuccess("desktop scroll", { direction, amount, x, y });
          return;
        }
        if (sub === "type") {
          const text = rest.join(" ") || (typeof flags.text === "string" ? flags.text : "");
          const delayMs = flags.delay ? Number.parseInt(String(flags.delay), 10) : 12;
          await ws.desktop.type({ text, delayMs });
          outputSuccess("desktop type", { length: text.length });
          return;
        }
        if (sub === "key") {
          const key = rest[0] ?? (typeof flags.key === "string" ? flags.key : "");
          if (!key)
            throw new Error("Usage: computer-cli desktop key <keySpec> [--action press|down|up]");
          const action = typeof flags.action === "string" ? flags.action : "press";
          await ws.desktop.key({ key, action });
          outputSuccess("desktop key", { key, action });
          return;
        }
        if (sub === "windows") {
          const windows = await ws.desktop.windows();
          outputSuccess("desktop windows", { count: windows.length, windows });
          return;
        }
        if (sub === "focus") {
          const target = rest.join(" ");
          if (!target) throw new Error("Usage: computer-cli desktop focus <window-id-or-title>");
          if (/^0x[0-9a-f]+$/i.test(target) || /^\d+$/.test(target)) {
            await ws.desktop.focusWindow({ id: target });
          } else {
            await ws.desktop.focusWindow({ title: target });
          }
          outputSuccess("desktop focus", { target });
          return;
        }
        if (sub === "cursor") {
          outputSuccess("desktop cursor", await ws.desktop.cursorPosition());
          return;
        }
        if (sub === "screen-size") {
          outputSuccess("desktop screen-size", await ws.desktop.screenSize());
          return;
        }
        if (sub === "clipboard-read") {
          const text = await ws.desktop.clipboardRead();
          outputSuccess("desktop clipboard-read", { text });
          return;
        }
        if (sub === "clipboard-write") {
          const text = rest.join(" ") || (typeof flags.text === "string" ? flags.text : "");
          await ws.desktop.clipboardWrite(text);
          outputSuccess("desktop clipboard-write", { length: text.length });
          return;
        }
        if (sub === "wait") {
          const ms = Number.parseInt(rest[0] ?? "1000", 10);
          await ws.desktop.wait(ms);
          outputSuccess("desktop wait", { durationMs: ms });
          return;
        }
        if (sub === "open-url") {
          const url = rest[0];
          if (!url) throw new Error("Usage: computer-cli desktop open-url <https://...>");
          const handle = await ws.runtime.exec(
            `nohup chromium --no-sandbox --disable-dev-shm-usage --no-first-run --no-default-browser-check --window-position=0,0 --window-size=1280,695 ${JSON.stringify(url)} >/dev/null 2>&1 &`,
            { encoding: "utf8" },
          );
          await handle.result();
          await ws.desktop.wait(1500);
          outputSuccess("desktop open-url", { url, noVncUrl: state.noVncUrl });
          return;
        }
        throw new Error(`Unknown desktop subcommand: ${sub}`);
      });
      return;
    }

    throw new Error(`Unknown command group: ${group}. Run with --help for usage.`);
  } catch (err) {
    outputError(
      cmdLabel,
      err,
      "Run `node bin/computer-cli.mjs status` or `node bin/computer-cli.mjs connect docker` to verify the active computerd connection.",
    );
  }
}

await main();
