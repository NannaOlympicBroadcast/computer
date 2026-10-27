// Standalone (no Cloudflare) smoke tests: a Workspace in plain Node.js
// with the default node:sqlite store, talking to a real computerd
// process over ComputerdBackend and a real Docker desktop container
// over DockerContainerBackend. No workerd, no Durable Object, no
// loader hook.

import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  ComputerdBackend,
  DockerContainerBackend,
  TailscaleComputerdBackend,
  discoverTailscalePeers,
  resolveTailscaleTarget,
} from "./backends/computerd/index.js";
import { getWorkspace } from "./client.js";
import { WorkspaceDesktop } from "./desktop/index.js";
import { NodeSQLiteStorage } from "./node-storage.js";
import { createAITools } from "./tools/ai-sdk/index.js";
import { createDesktopExecutor, desktopModelOutput } from "./tools/common/desktop.js";
import { createPiTools } from "./tools/pi-ai/index.js";
import { createTanStackTools } from "./tools/tanstack-ai/index.js";
import { Workspace } from "./workspace.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const cliPath = path.resolve(here, "../../computerd/dist/cli/computerd.cjs");

function hasDockerDesktopImage(): boolean {
  try {
    execFileSync("docker", ["image", "inspect", "computerd-desktop:latest"], {
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

describe("Workspace without Cloudflare", () => {
  test("defaults to an in-memory node:sqlite store", async () => {
    const ws = new Workspace({});
    await ws.fs.writeFile("/hello.txt", "hi");
    expect(await ws.fs.readFile("/hello.txt", "utf8")).toBe("hi");
  });

  test("persists to a file when `storage` is a path", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ws-standalone-"));
    const file = path.join(dir, "ws.db");
    const first = new Workspace({ storage: file });
    await first.fs.writeFile("/keep.txt", "kept");
    const second = new Workspace({ storage: new NodeSQLiteStorage(file) });
    expect(await second.fs.readFile("/keep.txt", "utf8")).toBe("kept");
  });

  test("getWorkspace accepts a standalone Workspace instance directly", async () => {
    const ws = new Workspace({});
    await ws.fs.writeFile("/client.txt", "via-client");
    using client = await getWorkspace(ws);
    expect(await client.fs.readFile("/client.txt", "utf8")).toBe("via-client");
    expect(client.desktop).toBeDefined();
  });

  test("workspace.desktop rejects without a backend", async () => {
    const ws = new Workspace({});
    await expect(ws.desktop.status()).rejects.toThrow(/needs a computerd backend/);
  });
});

describe("Workspace + ComputerdBackend", () => {
  let child: ChildProcess | undefined;
  let url = "";
  let port = 0;
  let dir = "";

  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "ws-computerd-"));
    port = await freePort();
    url = `http://127.0.0.1:${port}`;
    child = spawn(process.execPath, [cliPath], {
      env: {
        ...process.env,
        PORT: String(port),
        FUSE_MOUNT: "none",
        MOUNT_POINT: path.join(dir, "mnt"),
        COMPUTERD_DB: path.join(dir, "computerd.db"),
        RPC_CLIENT_SECRET: "secret",
      },
      stdio: "ignore",
    });
  }, 30_000);

  afterAll(() => {
    child?.kill();
  });

  test("syncs files and reports the desktop as unavailable", async () => {
    const ws = new Workspace({
      backends: [new ComputerdBackend({ url, secret: "secret", readyTimeoutMs: 20_000 })],
    });
    try {
      await ws.fs.mkdir("/workspace", { recursive: true });
      await ws.fs.writeFile("/workspace/a.txt", "from host");
      for await (const _ of ws.push()) {
        // drain
      }
      // computerd was started without a desktop.
      expect(await ws.desktop.status()).toMatchObject({ enabled: false, running: false });
      await expect(ws.desktop.screenshot()).rejects.toThrow(/desktop|ENOSYS|not/i);
    } finally {
      await ws.close();
    }
  }, 60_000);

  test("discovers Tailscale peers and connects via TailscaleComputerdBackend", async () => {
    const fakeTailscaleStatus = JSON.stringify({
      Self: {
        ID: "self-node",
        HostName: "local-dev",
        DNSName: "local-dev.tail1234.ts.net.",
        TailscaleIPs: ["100.64.0.1"],
        OS: "windows",
        Online: true,
      },
      Peer: {
        "nodekey:abc": {
          ID: "peer-1",
          HostName: "ubuntu-gpu",
          DNSName: "ubuntu-gpu.tail1234.ts.net.",
          TailscaleIPs: ["127.0.0.1", "fd7a:115c:a1e0::2"],
          OS: "linux",
          Online: true,
        },
        "nodekey:offline": {
          ID: "peer-2",
          HostName: "old-laptop",
          DNSName: "old-laptop.tail1234.ts.net.",
          TailscaleIPs: ["100.64.0.99"],
          OS: "macos",
          Online: false,
        },
      },
    });
    const execCommand = async () => fakeTailscaleStatus;

    const peers = await discoverTailscalePeers({
      execCommand,
      probeComputerdPort: port,
      noVncPort: 6080,
    });
    expect(peers).toHaveLength(2);
    const gpuPeer = peers.find((p) => p.hostName === "ubuntu-gpu");
    expect(gpuPeer?.computerd).toEqual({
      reachable: true,
      url: `http://127.0.0.1:${port}`,
      noVncUrl: "http://127.0.0.1:6080/vnc.html?autoconnect=true&resize=scale",
    });

    const magicTarget = await resolveTailscaleTarget({
      peer: "ubuntu-gpu",
      port,
      preferMagicDns: true,
      execCommand,
    });
    expect(magicTarget.url).toBe(`http://ubuntu-gpu.tail1234.ts.net:${port}`);

    const backend = new TailscaleComputerdBackend({
      peer: "ubuntu-gpu",
      port,
      secret: "secret",
      readyTimeoutMs: 20_000,
      execCommand,
    });
    const ws = new Workspace({ backends: [backend] });
    try {
      await ws.fs.mkdir("/workspace", { recursive: true });
      await ws.fs.writeFile("/workspace/tailscale.txt", "via-tailnet");
      for await (const _ of ws.push()) {
        // drain
      }
      expect(backend.url).toBe(`http://127.0.0.1:${port}`);
      expect(backend.noVncUrl).toBe("http://127.0.0.1:6080/vnc.html?autoconnect=true&resize=scale");
      expect(backend.peerInfo?.hostName).toBe("ubuntu-gpu");
    } finally {
      await ws.close();
    }
  }, 60_000);
});

describe.skipIf(!hasDockerDesktopImage())(
  "Workspace + DockerContainerBackend (desktop container)",
  () => {
    test("runs desktop container, syncs FUSE files, and drives X11 GUI end-to-end", async () => {
      const noVncHostPort = await freePort();
      const ws = new Workspace({
        backends: [
          new DockerContainerBackend({
            image: "computerd-desktop:latest",
            desktop: { resolution: "1280x720x24", hostNoVncPort: noVncHostPort },
            dockerArgs: ["--privileged"],
          }),
        ],
      });

      try {
        // 1. Verify desktop status, screen size, and noVNC HTTP viewer endpoint.
        const status = await ws.desktop.status();
        expect(status).toMatchObject({
          enabled: true,
          running: true,
          display: ":99",
          width: 1280,
          height: 720,
          depth: 24,
          vncPort: 5900,
          noVncPort: 6080,
        });
        expect(await ws.desktop.screenSize()).toEqual({
          width: 1280,
          height: 720,
          display: ":99",
        });
        const noVncRes = await fetch(`http://127.0.0.1:${noVncHostPort}/vnc.html`);
        expect(noVncRes.status).toBe(200);
        expect(await noVncRes.text()).toContain("noVNC");

        // 2. Sync a file from the host SQLite store into the container's FUSE /workspace.
        await ws.fs.mkdir("/workspace", { recursive: true });
        await ws.fs.writeFile("/workspace/from-host.txt", "hello-fuse\n");

        // 3. Mouse movement, clicks, drag, scroll, and cursorPosition.
        await ws.desktop.move({ x: 320, y: 240 });
        expect(await ws.desktop.cursorPosition()).toMatchObject({ x: 320, y: 240 });
        await ws.desktop.click({ x: 320, y: 240, button: "left" });
        await ws.desktop.doubleClick({ x: 320, y: 240 });
        await ws.desktop.rightClick({ x: 320, y: 240 });
        await ws.desktop.drag({ startX: 100, startY: 100, endX: 400, endY: 300, steps: 4 });
        expect(await ws.desktop.cursorPosition()).toMatchObject({ x: 400, y: 300 });
        await ws.desktop.scroll({ x: 400, y: 300, direction: "down", amount: 2 });

        // 4. Clipboard read and write over X11.
        await ws.desktop.clipboardWrite("clipboard-e2e-value");
        expect(await ws.desktop.clipboardRead()).toBe("clipboard-e2e-value");

        // 5. Launch an X11 window (xterm) and interact with it via desktop RPC.
        const handle = await ws.runtime.exec(
          'cat /workspace/from-host.txt && nohup xterm -title "DesktopTestTerm" -e "head -n 1 > /workspace/from-xterm.txt" >/dev/null 2>&1 &',
          { encoding: "utf8" },
        );
        const execRes = await handle.result();
        expect(execRes.exitCode).toBe(0);
        expect(execRes.stdout).toContain("hello-fuse");

        // Poll until xterm registers with the window manager.
        let windows = await ws.desktop.windows();
        for (let i = 0; i < 20 && !windows.some((w) => w.title.includes("DesktopTestTerm")); i++) {
          await ws.desktop.wait(200);
          windows = await ws.desktop.windows();
        }
        expect(windows.some((w) => w.title.includes("DesktopTestTerm"))).toBe(true);

        await ws.desktop.focusWindow({ title: "DesktopTestTerm" });
        await ws.desktop.wait(100);
        await ws.desktop.type("typed-into-x11");
        await ws.desktop.key("Return");

        // Wait briefly for xterm to flush to FUSE, then pull and verify on the host.
        let xtermText = "";
        for (let i = 0; i < 15; i++) {
          await ws.desktop.wait(150);
          for await (const _ of ws.pull()) {
            // drain
          }
          xtermText = (
            await ws.fs.readFile("/workspace/from-xterm.txt", "utf8").catch(() => "")
          ).trim();
          if (xtermText.length > 0) break;
        }
        expect(xtermText).toBe("typed-into-x11");

        // 6. Take a real PNG screenshot and verify PNG header + dimensions.
        const shot = await ws.desktop.screenshot({ format: "png" });
        expect(shot.mimeType).toBe("image/png");
        expect(shot.width).toBe(1280);
        expect(shot.height).toBe(720);
        expect(Array.from(shot.data.subarray(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]);

        // 7. Verify agent tool integration (AI SDK, Pi, TanStack) against the live desktop.
        const aiTools = createAITools({ workspace: ws, desktop: true });
        expect(aiTools.desktop).toBeDefined();
        const piTools = createPiTools({ workspace: ws, desktop: true });
        expect(piTools.tools.some((t) => t.name === "desktop")).toBe(true);
        const piRes = await piTools.execute({
          id: "call-1",
          name: "desktop",
          arguments: { action: "screenshot" },
        });
        expect(piRes.isError).toBe(false);
        expect(piRes.content.some((c) => c.type === "image")).toBe(true);
      } finally {
        await ws.close();
      }
    }, 90_000);
  },
);

describe("desktop tool", () => {
  const png = new Uint8Array([137, 80, 78, 71]);
  const calls: string[] = [];
  const fake = {
    screenshot: async () => ({ data: png, mimeType: "image/png", width: 10, height: 20 }),
    click: async () => void calls.push("click"),
    doubleClick: async () => void calls.push("doubleClick"),
    tripleClick: async () => void calls.push("tripleClick"),
    rightClick: async () => void calls.push("rightClick"),
    middleClick: async () => void calls.push("middleClick"),
    move: async () => void calls.push("move"),
    drag: async () => void calls.push("drag"),
    scroll: async () => void calls.push("scroll"),
    type: async () => void calls.push("type"),
    key: async () => void calls.push("key"),
    cursorPosition: async () => ({ x: 1, y: 2 }),
    screenSize: async () => ({ width: 10, height: 20 }),
    windows: async () => [],
    focusWindow: async () => void calls.push("focus"),
    clipboardRead: async () => "clip",
    clipboardWrite: async () => void calls.push("clipboardWrite"),
    wait: async () => void calls.push("wait"),
  };

  test("encodes screenshots as media and reports missing arguments", async () => {
    const run = createDesktopExecutor({ desktop: fake });
    const shot = await run({ action: "screenshot" });
    const output = desktopModelOutput(shot);
    expect(output.type).toBe("media");
    expect(await run({ action: "click", x: 1, y: 2 })).toEqual({ ok: true, action: "click" });
    expect(await run({ action: "type" })).toMatchObject({ ok: false });
    expect(await run({ action: "cursor_position" })).toEqual({ ok: true, x: 1, y: 2 });
    expect(calls).toContain("click");
    const tsTools = createTanStackTools({
      workspace: {
        fs: {} as never,
        desktop: fake,
      },
      desktop: true,
    });
    expect(tsTools.some((t) => t.name === "desktop")).toBe(true);
  });

  test("fails fast without a desktop", () => {
    expect(() => createDesktopExecutor({})).toThrow(/not available/);
  });

  test("WorkspaceDesktop forwards through its dispatcher", async () => {
    const seen: string[] = [];
    const desktop = new WorkspaceDesktop(async (_backend, operation, policy, op) => {
      seen.push(`${operation}:${policy}`);
      return op({ click: async () => undefined } as never);
    });
    await desktop.click({ x: 1, y: 1 });
    expect(seen).toEqual(["desktop.click:pre-dispatch"]);
  });
});
