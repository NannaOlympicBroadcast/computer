// Shared runtime & connection state manager for both:
//   - plugins/computer-agent/bin/computer-cli.mjs (Direct CLI)
//   - plugins/computer-agent/mcp/server.mjs       (MCP Server)
//
// Supports 4 connection modes:
//   1. "url"       — Connect to any local/LAN/remote computerd URL (default http://127.0.0.1:8080)
//   2. "tailscale" — Connect to a remote computerd node across a Tailscale Tailnet (by hostname, MagicDNS, IP, or auto-probe)
//   3. "docker"    — Manage & connect to a local Docker desktop container (computerd-desktop:latest)
//   4. "local"     — Pure local NodeSQLiteStorage Workspace (fs + git only, no container required)

import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(here, "..");

async function fileExists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export async function resolveRepoRoot() {
  if (process.env.COMPUTER_REPO_ROOT) {
    return path.resolve(process.env.COMPUTER_REPO_ROOT);
  }
  const pointerFile = path.join(pluginRoot, "repo-root.json");
  if (await fileExists(pointerFile)) {
    try {
      const data = JSON.parse(await fs.readFile(pointerFile, "utf8"));
      if (data.repoRoot && (await fileExists(data.repoRoot))) {
        return data.repoRoot;
      }
    } catch {
      // ignore invalid pointer
    }
  }
  const candidate = path.resolve(pluginRoot, "../..");
  if (await fileExists(path.join(candidate, "packages/computer/dist/index.js"))) {
    return candidate;
  }
  return candidate;
}

export async function loadComputerSdk() {
  const repoRoot = await resolveRepoRoot();
  const computerEntry = pathToFileURL(path.join(repoRoot, "packages/computer/dist/index.js")).href;
  const backendsEntry = pathToFileURL(
    path.join(repoRoot, "packages/computer/dist/backends/computerd/index.js"),
  ).href;
  const aiToolsEntry = pathToFileURL(
    path.join(repoRoot, "packages/computer/dist/tools/ai-sdk.js"),
  ).href;

  const [computerMod, backendsMod, aiToolsMod] = await Promise.all([
    import(computerEntry),
    import(backendsEntry),
    import(aiToolsEntry),
  ]);

  return {
    repoRoot,
    Workspace: computerMod.Workspace,
    NodeSQLiteStorage: computerMod.NodeSQLiteStorage,
    ComputerdBackend: backendsMod.ComputerdBackend,
    DockerContainerBackend: backendsMod.DockerContainerBackend,
    TailscaleComputerdBackend: backendsMod.TailscaleComputerdBackend,
    discoverTailscalePeers: backendsMod.discoverTailscalePeers,
    resolveTailscaleTarget: backendsMod.resolveTailscaleTarget,
    waitForComputerd: backendsMod.waitForComputerd,
    createAITools: aiToolsMod.createAITools,
  };
}

export async function loadMcpSdk() {
  const repoRoot = await resolveRepoRoot();
  const serverIndexEntry = pathToFileURL(
    path.join(repoRoot, "node_modules/@modelcontextprotocol/sdk/dist/esm/server/index.js"),
  ).href;
  const stdioEntry = pathToFileURL(
    path.join(repoRoot, "node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js"),
  ).href;
  const typesEntry = pathToFileURL(
    path.join(repoRoot, "node_modules/@modelcontextprotocol/sdk/dist/esm/types.js"),
  ).href;
  const [serverMod, stdioMod, typesMod] = await Promise.all([
    import(serverIndexEntry),
    import(stdioEntry),
    import(typesEntry),
  ]);
  return {
    Server: serverMod.Server,
    StdioServerTransport: stdioMod.StdioServerTransport,
    ListToolsRequestSchema: typesMod.ListToolsRequestSchema,
    CallToolRequestSchema: typesMod.CallToolRequestSchema,
  };
}

export function getStateFilePath() {
  if (process.env.COMPUTER_STATE_FILE) {
    return path.resolve(process.env.COMPUTER_STATE_FILE);
  }
  return path.join(os.homedir(), ".computer-agent", "state.json");
}

const DEFAULT_STATE = {
  mode: "url",
  url: "http://127.0.0.1:8080",
  secret: "local-dev-secret",
  noVncUrl: "http://127.0.0.1:6080/vnc.html?autoconnect=true&resize=scale",
  vncAddress: "127.0.0.1:5900",
  storage: path.join(os.homedir(), ".computer-agent", "workspace.db"),
  dockerContainer: "computer-desktop-demo",
  dockerImage: "computerd-desktop:latest",
};

export async function loadConnectionState() {
  const stateFile = getStateFilePath();
  let saved = {};
  if (await fileExists(stateFile)) {
    try {
      saved = JSON.parse(await fs.readFile(stateFile, "utf8"));
    } catch {
      saved = {};
    }
  }

  const state = {
    ...DEFAULT_STATE,
    ...saved,
  };

  if (process.env.COMPUTER_MODE) state.mode = process.env.COMPUTER_MODE;
  if (process.env.COMPUTER_URL) state.url = process.env.COMPUTER_URL;
  if (process.env.COMPUTER_SECRET !== undefined) state.secret = process.env.COMPUTER_SECRET;
  if (process.env.COMPUTER_STORAGE) state.storage = process.env.COMPUTER_STORAGE;
  if (process.env.COMPUTER_TAILSCALE_PEER) {
    state.mode = "tailscale";
    state.tailscalePeer = process.env.COMPUTER_TAILSCALE_PEER;
  }
  if (process.env.COMPUTER_TAILSCALE_PORT) {
    state.tailscalePort = Number.parseInt(process.env.COMPUTER_TAILSCALE_PORT, 10);
  }
  return state;
}

export async function saveConnectionState(patch) {
  const current = await loadConnectionState();
  const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
  const stateFile = getStateFilePath();
  await fs.mkdir(path.dirname(stateFile), { recursive: true });
  await fs.writeFile(stateFile, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return next;
}

export function runDockerCmd(args) {
  return new Promise((resolve, reject) => {
    execFile("docker", args, { timeout: 30_000 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`docker ${args.join(" ")} failed: ${stderr?.trim() || error.message}`));
      } else {
        resolve({ stdout: String(stdout).trim(), stderr: String(stderr).trim() });
      }
    });
  });
}

export async function ensureDockerDesktopContainer(options = {}) {
  const name = options.name ?? "computer-desktop-demo";
  const image = options.image ?? "computerd-desktop:latest";
  const hostPort = options.port ?? 8080;
  const noVncPort = options.noVncPort ?? 6080;
  const vncPort = options.vncPort ?? 5900;
  const resolution = options.resolution ?? "1280x720x24";
  const secret = options.secret ?? "local-dev-secret";

  // Check if container is already running
  const inspect = await runDockerCmd(["inspect", "-f", "{{.State.Running}}", name]).catch(
    () => null,
  );

  if (inspect?.stdout !== "true") {
    await runDockerCmd(["rm", "-f", name]).catch(() => null);
    await runDockerCmd([
      "run",
      "-d",
      "--name",
      name,
      "--privileged",
      "-p",
      `${hostPort}:8080`,
      "-p",
      `${vncPort}:5900`,
      "-p",
      `${noVncPort}:6080`,
      "-e",
      "DESKTOP_ENABLED=1",
      "-e",
      `DESKTOP_RESOLUTION=${resolution}`,
      "-e",
      `RPC_CLIENT_SECRET=${secret}`,
      image,
    ]);
  }

  const url = `http://127.0.0.1:${hostPort}`;
  const noVncUrl = `http://127.0.0.1:${noVncPort}/vnc.html?autoconnect=true&resize=scale`;
  const vncAddress = `127.0.0.1:${vncPort}`;

  const sdk = await loadComputerSdk();
  await sdk.waitForComputerd(url, secret, 30_000);

  return await saveConnectionState({
    mode: "url",
    url,
    secret,
    noVncUrl,
    vncAddress,
    dockerContainer: name,
    dockerImage: image,
  });
}

export async function createConfiguredWorkspace(overrideState) {
  const sdk = await loadComputerSdk();
  const state = overrideState ?? (await loadConnectionState());
  await fs.mkdir(path.dirname(state.storage), { recursive: true });

  const backends = [];
  if (state.mode === "tailscale") {
    backends.push(
      new sdk.TailscaleComputerdBackend({
        id: "computerd",
        peer: state.tailscalePeer,
        port: state.tailscalePort ?? 8080,
        noVncPort: state.noVncPort ?? 6080,
        secret: state.secret || undefined,
        preferMagicDns: Boolean(state.preferMagicDns),
      }),
    );
  } else if (state.mode === "url") {
    backends.push(
      new sdk.ComputerdBackend({
        id: "computerd",
        url: state.url,
        secret: state.secret || undefined,
      }),
    );
  }

  const ws = new sdk.Workspace({
    storage: state.storage,
    backends,
  });

  return { ws, state, sdk };
}

export async function withWorkspace(fn, overrideState) {
  const { ws, state, sdk } = await createConfiguredWorkspace(overrideState);
  try {
    return await fn(ws, state, sdk);
  } finally {
    await ws.close().catch(() => undefined);
  }
}
