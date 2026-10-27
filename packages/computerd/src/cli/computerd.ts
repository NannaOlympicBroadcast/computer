#!/usr/bin/env node

import { timingSafeEqual } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { isAbsolute } from "node:path";
import type { DesktopStatus, ExecEvent as RpcExecEvent } from "@cloudflare/computer-rpc";
import { isStubTrackingEnabled, stubSnapshot } from "@cloudflare/computer-rpc/debug";
import type { RunnerLike } from "@cloudflare/computer-rpc/server";
import { acceptWebSocketSession, createWorkspaceServer } from "@cloudflare/computer-rpc/server";
import type { Database } from "@cloudflare/dofs";
import { WebSocket, WebSocketServer } from "ws";
import { DesktopController, parseDesktopEnv } from "../desktop/index.js";
import { Runner } from "../exec/index.js";
import type { ExecEvent as ComputerdExecEvent } from "../exec/types.js";
import {
  createNodeVirtualFileSystem,
  describeMountIgnore,
  type FUSEBackend,
  type FuseMount,
  type MountIgnoreInfo,
  mountFuse,
  parseFuseMountMode,
  parseStoreMode,
  type ResolvedStore,
  resolveFuseBackend,
  resolveMountIgnoreConfig,
  resolveStore,
} from "../fuse/index.js";
import { mountShim, type ShimMount } from "../shim/index.js";
import { installLogging } from "./logger.js";

// The compiled-in default port. esbuild's `define` substitutes the
// real value at SEA bundle time when COMPUTERD_DEFAULT_PORT is set on
// the build host; tsc-only builds keep the literal 45678 below.
// Runtime `PORT` env still wins over this default.
declare const __COMPUTERD_BUILD_DEFAULT_PORT__: number | undefined;
const BUILD_DEFAULT_PORT: number | undefined =
  typeof __COMPUTERD_BUILD_DEFAULT_PORT__ === "number"
    ? __COMPUTERD_BUILD_DEFAULT_PORT__
    : undefined;
const DEFAULT_PORT = BUILD_DEFAULT_PORT ?? 45678;
const DEFAULT_MOUNT_POINT = "/workspace";
const HOST = "0.0.0.0";

const LEGACY_FUSE_ENV_MIGRATION: Record<string, string> = {
  DISABLE_FUSE: "FUSE_MOUNT=none",
  FUSE_SHIM: "FUSE_MOUNT=shim",
  WSD_FUSE_BACKEND: "FUSE_MOUNT=fuse (linux) or FUSE_MOUNT=macfuse (darwin)",
};

function rejectLegacyFuseEnv(env: NodeJS.ProcessEnv): void {
  for (const [name, replacement] of Object.entries(LEGACY_FUSE_ENV_MIGRATION)) {
    const value = env[name];
    if (value !== undefined && value !== "") {
      throw new Error(
        `${name} is no longer supported; use ${replacement} instead (FUSE_MOUNT defaults to auto)`,
      );
    }
  }
}

function parsePort(value: string | undefined): number {
  if (value === undefined || value === "") {
    return DEFAULT_PORT;
  }

  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`PORT must be an integer between 0 and 65535, got ${JSON.stringify(value)}`);
  }

  return port;
}

function parseMountPoint(value: string | undefined): string {
  const mountPoint = value === undefined || value === "" ? DEFAULT_MOUNT_POINT : value;
  if (!isAbsolute(mountPoint)) {
    throw new Error(`MOUNT_POINT must be an absolute path, got ${JSON.stringify(value)}`);
  }

  return mountPoint;
}

function send(
  response: ServerResponse,
  statusCode: number,
  body: string,
  headers: Record<string, string> = {},
): void {
  response.writeHead(statusCode, {
    "content-length": Buffer.byteLength(body).toString(),
    ...headers,
  });
  response.end(body);
}

function requestPath(request: IncomingMessage): string {
  const url = new URL(request.url ?? "/", "http://localhost");
  return url.pathname;
}

const UNAUTHENTICATED_PATHS = new Set(["/health"]);

function isAuthorized(request: IncomingMessage, secret: string | undefined): boolean {
  if (secret === undefined) return true;
  const header = request.headers.authorization;
  if (typeof header !== "string") return false;
  const separator = header.indexOf(" ");
  if (separator === -1) return false;
  if (header.slice(0, separator).toLowerCase() !== "bearer") return false;
  const presented = Buffer.from(header.slice(separator + 1).trim());
  const expected = Buffer.from(secret);
  if (presented.length !== expected.length) return false;
  return timingSafeEqual(presented, expected);
}

function dropHeartbeats(stream: ReadableStream<ComputerdExecEvent>): ReadableStream<RpcExecEvent> {
  return stream.pipeThrough(
    new TransformStream<ComputerdExecEvent, RpcExecEvent>({
      transform(event, controller) {
        if (event.name !== "heartbeat") {
          controller.enqueue(event as RpcExecEvent);
        }
      },
    }),
  );
}

interface ComputerdInfo {
  backend: FUSEBackend;
  mountPoint: string;
  port: number;
  store: ResolvedStore;
  ignore: MountIgnoreInfo;
  desktop?: DesktopStatus;
}

function collectDbStats(db: Database): Record<string, unknown> {
  // oxlint-disable-next-line typescript/no-explicit-any -- small ad-hoc shape
  const out: Record<string, any> = {};
  try {
    out.vfs_nodes_count = db.scalar<number>("SELECT COUNT(*) FROM vfs_nodes") ?? 0;
    out.vfs_dirents_count = db.scalar<number>("SELECT COUNT(*) FROM vfs_dirents") ?? 0;
    out.vfs_chunks_count = db.scalar<number>("SELECT COUNT(*) FROM vfs_chunks") ?? 0;
    out.vfs_blobs_count = db.scalar<number>("SELECT COUNT(*) FROM vfs_blobs") ?? 0;
    out.vfs_blob_bytes_total =
      db.scalar<number>("SELECT COALESCE(SUM(LENGTH(bytes)), 0) FROM vfs_blob_bytes") ?? 0;
    out.vfs_blobs_orphan =
      db.scalar<number>(
        "SELECT COUNT(*) FROM vfs_blobs b WHERE NOT EXISTS (SELECT 1 FROM vfs_chunks c WHERE c.hash = b.hash)",
      ) ?? 0;
    out.vfs_blob_bytes_orphan =
      db.scalar<number>(
        "SELECT COALESCE(SUM(LENGTH(bytes)), 0) FROM vfs_blob_bytes bb WHERE NOT EXISTS (SELECT 1 FROM vfs_chunks c WHERE c.hash = bb.hash)",
      ) ?? 0;
  } catch (error) {
    out.error = (error as Error).message;
  }
  const mem = process.memoryUsage();
  out.rss = mem.rss;
  out.heap_used = mem.heapUsed;
  out.heap_total = mem.heapTotal;
  out.external = mem.external;
  out.array_buffers = mem.arrayBuffers;
  return out;
}

interface HTTPHandle {
  server: Server;
  close: () => Promise<void>;
}

function createHTTPServer(
  info: ComputerdInfo,
  rpc: ReturnType<typeof createWorkspaceServer>,
  secret: string | undefined,
  getStats?: () => Record<string, unknown>,
  checkpoint?: () => { walFrames: number; sizeBytes: number; durationMs: number },
  desktop?: DesktopController,
): HTTPHandle {
  const upstreamSlot: { ws: WebSocket | undefined } = { ws: undefined };
  const server = createServer((request, response) => {
    const path = requestPath(request);

    if (!UNAUTHENTICATED_PATHS.has(path) && !isAuthorized(request, secret)) {
      send(response, 401, "unauthorized\n", {
        "www-authenticate": "Bearer",
        "content-type": "text/plain; charset=utf-8",
      });
      return;
    }

    if (path === "/api") {
      send(response, 400, "/api requires a websocket upgrade\n", {
        "content-type": "text/plain; charset=utf-8",
      });
      return;
    }

    if (path === "/connect") {
      if (request.method !== "POST") {
        send(response, 405, "method not allowed\n", {
          allow: "POST",
          "content-type": "text/plain; charset=utf-8",
        });
        return;
      }
      void handleConnect(request, response, rpc, upstreamSlot, secret);
      return;
    }

    if (path === "/__computerd/checkpoint") {
      if (request.method !== "POST") {
        send(response, 405, "method not allowed\n", {
          allow: "POST",
          "content-type": "text/plain; charset=utf-8",
        });
        return;
      }
      if (checkpoint === undefined) {
        send(response, 404, "checkpoint unavailable\n", {
          "content-type": "text/plain; charset=utf-8",
        });
        return;
      }
      try {
        send(response, 200, JSON.stringify(checkpoint()), {
          "content-type": "application/json; charset=utf-8",
        });
      } catch (error) {
        console.error("/__computerd/checkpoint failed:", error);
        send(response, 500, "internal error\n", {
          "content-type": "text/plain; charset=utf-8",
        });
      }
      return;
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      send(response, 405, "method not allowed\n", {
        allow: "GET, HEAD",
        "content-type": "text/plain; charset=utf-8",
      });
      return;
    }

    if (path === "/api/watermarks") {
      if (request.method === "HEAD") {
        send(response, 200, "", { "content-type": "application/json; charset=utf-8" });
        return;
      }
      void rpc.sync
        .watermarks()
        .then((watermarks) => {
          send(response, 200, JSON.stringify(watermarks), {
            "content-type": "application/json; charset=utf-8",
          });
        })
        .catch((error: unknown) => {
          console.error("/api/watermarks failed:", error);
          if (!response.headersSent) {
            send(response, 500, "internal error\n", {
              "content-type": "text/plain; charset=utf-8",
            });
          }
        });
      return;
    }

    if (path === "/desktop/screenshot") {
      if (desktop === undefined) {
        send(response, 404, "desktop unavailable\n", {
          "content-type": "text/plain; charset=utf-8",
        });
        return;
      }
      const reqUrl = new URL(request.url ?? "/", "http://localhost");
      const format = reqUrl.searchParams.get("format") === "jpeg" ? "jpeg" : "png";
      void desktop
        .screenshot({ format })
        .then((shot) => {
          const buf = Buffer.from(shot.data);
          response.writeHead(200, {
            "content-type": shot.mimeType,
            "content-length": buf.byteLength.toString(),
            "x-desktop-width": String(shot.width),
            "x-desktop-height": String(shot.height),
          });
          if (request.method === "HEAD") {
            response.end();
          } else {
            response.end(buf);
          }
        })
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          if (!response.headersSent) {
            send(response, 500, `${message}\n`, {
              "content-type": "text/plain; charset=utf-8",
            });
          }
        });
      return;
    }

    if (path === "/health") {
      const body = request.method === "HEAD" ? "" : "ok\n";
      send(response, 200, body, {
        "content-type": "text/plain; charset=utf-8",
      });
      return;
    }

    if (path === "/__computerd/stubs") {
      if (!isStubTrackingEnabled()) {
        send(response, 404, "stub tracking disabled (set CAPNWEB_TRACK_STUBS=1)\n", {
          "content-type": "text/plain; charset=utf-8",
        });
        return;
      }
      const body = request.method === "HEAD" ? "" : JSON.stringify(stubSnapshot());
      send(response, 200, body, {
        "content-type": "application/json; charset=utf-8",
      });
      return;
    }

    if (path === "/__computerd/stats") {
      const stats = getStats?.() ?? {};
      const body = request.method === "HEAD" ? "" : JSON.stringify(stats);
      send(response, 200, body, {
        "content-type": "application/json; charset=utf-8",
      });
      return;
    }

    if (path === "/__computerd/info") {
      const snapshot: ComputerdInfo = {
        ...info,
        ...(desktop !== undefined ? { desktop: desktop.getStatusSync() } : {}),
      };
      const body = request.method === "HEAD" ? "" : JSON.stringify(snapshot);
      send(response, 200, body, {
        "content-type": "application/json; charset=utf-8",
      });
      return;
    }

    if (path === "/") {
      const body = request.method === "HEAD" ? "" : "{}";
      send(response, 200, body, {
        "content-type": "application/json; charset=utf-8",
      });
      return;
    }

    send(response, 404, "not found\n", {
      "content-type": "text/plain; charset=utf-8",
    });
  });

  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: true });
  wss.on("connection", (ws) => {
    acceptWebSocketSession(ws, rpc);
  });
  server.on("upgrade", (request, socket, head) => {
    if (!isAuthorized(request, secret)) {
      socket.write(
        "HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Bearer\r\nConnection: close\r\n\r\n",
      );
      socket.destroy();
      return;
    }
    if (requestPath(request) !== "/api") {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
      return;
    }
    const versionHeader = request.headers["sec-websocket-version"];
    const version = typeof versionHeader === "string" ? Number(versionHeader.trim()) : Number.NaN;
    if (Number.isInteger(version) && version !== 13 && version !== 8) {
      socket.write(
        "HTTP/1.1 426 Upgrade Required\r\n" +
          "Sec-WebSocket-Version: 13, 8\r\n" +
          "Connection: close\r\n\r\n",
      );
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket as Socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  });

  return {
    server,
    close: async () => {
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await closeServer(server);
    },
  };
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error !== undefined) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

interface ConnectBody {
  base?: unknown;
  health?: unknown;
  api?: unknown;
  healthTimeoutMs?: unknown;
}

function isEndpointPath(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (!value.startsWith("/")) return false;
  if (value.startsWith("//")) return false;
  return !URL.canParse(value);
}

async function handleConnect(
  request: IncomingMessage,
  response: ServerResponse,
  rpc: ReturnType<typeof createWorkspaceServer>,
  upstreamSlot: { ws: WebSocket | undefined },
  secret: string | undefined,
): Promise<void> {
  let body: ConnectBody;
  try {
    body = await readJson<ConnectBody>(request);
  } catch (error) {
    send(response, 400, `invalid JSON body: ${(error as Error).message}\n`, {
      "content-type": "text/plain; charset=utf-8",
    });
    return;
  }

  if (
    typeof body.base !== "string" ||
    !(body.base.startsWith("http://") || body.base.startsWith("https://"))
  ) {
    send(response, 400, "'base' must be an http:// or https:// URL\n", {
      "content-type": "text/plain; charset=utf-8",
    });
    return;
  }
  if (!isEndpointPath(body.health)) {
    send(response, 400, "'health' must be an absolute path such as /health\n", {
      "content-type": "text/plain; charset=utf-8",
    });
    return;
  }
  if (!isEndpointPath(body.api)) {
    send(response, 400, "'api' must be an absolute path such as /api\n", {
      "content-type": "text/plain; charset=utf-8",
    });
    return;
  }
  const baseUrl = body.base.replace(/\/+$/, "");
  const healthUrl = `${baseUrl}${body.health}`;
  const healthTimeoutMs =
    typeof body.healthTimeoutMs === "number" && body.healthTimeoutMs > 0
      ? body.healthTimeoutMs
      : 30_000;

  try {
    await waitForHealth(healthUrl, healthTimeoutMs);
  } catch (error) {
    send(response, 502, `readiness probe unreachable: ${(error as Error).message}\n`, {
      "content-type": "text/plain; charset=utf-8",
    });
    return;
  }

  const previous = upstreamSlot.ws;
  if (previous !== undefined) {
    upstreamSlot.ws = undefined;
    try {
      previous.close(1000, "replaced by new /connect");
    } catch {
      // already closed; idempotent
    }
  }

  const wsUrl = `${toWebSocketUrl(baseUrl)}${body.api}`;
  const ws = new WebSocket(wsUrl, {
    ...(secret !== undefined ? { headers: { authorization: `Bearer ${secret}` } } : {}),
  });
  upstreamSlot.ws = ws;
  ws.once("open", () => {
    console.log(`/connect: attached RPC session to ${wsUrl}`);
    acceptWebSocketSession(ws, rpc);
  });
  ws.once("close", () => {
    if (upstreamSlot.ws === ws) upstreamSlot.ws = undefined;
  });
  ws.once("error", (err) => {
    console.error(`/connect: WebSocket error against ${wsUrl}:`, err.message);
  });
  send(response, 200, `${JSON.stringify({ ok: true, ws: wsUrl })}\n`, {
    "content-type": "application/json; charset=utf-8",
  });
}

async function readJson<T>(request: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (text.length === 0) return {} as T;
  return JSON.parse(text) as T;
}

function toWebSocketUrl(input: string): string {
  if (input.startsWith("http://")) return `ws://${input.slice("http://".length)}`;
  if (input.startsWith("https://")) return `wss://${input.slice("https://".length)}`;
  throw new Error(`unsupported URL scheme: ${input}`);
}

async function waitForHealth(healthUrl: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(healthUrl);
      if (res.ok) return;
      lastError = new Error(`HTTP ${res.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    `${healthUrl} not healthy within ${timeoutMs}ms: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}

async function main(): Promise<void> {
  const teardownLogging = installLogging(process.env.LOG_FILE);

  rejectLegacyFuseEnv(process.env);

  const clientSecret = process.env.RPC_CLIENT_SECRET?.trim() || undefined;
  delete process.env.RPC_CLIENT_SECRET;

  const port = parsePort(process.env.PORT);
  const mountPoint = parseMountPoint(process.env.MOUNT_POINT);
  const fuseMountMode = parseFuseMountMode(process.env.FUSE_MOUNT);
  const backend: FUSEBackend = await resolveFuseBackend(fuseMountMode);
  console.log(`[info] FUSE_MOUNT=${fuseMountMode} resolved to backend=${backend.kind}`);

  const ignoreConfig = resolveMountIgnoreConfig(process.env, mountPoint);
  if (ignoreConfig.enabled && backend.kind === "shim") {
    throw new Error(
      `MOUNT_IGNORE is not supported on the userspace shim (FUSE_MOUNT=${fuseMountMode} ` +
        `resolved to backend=shim). Run with real FUSE, or unset MOUNT_IGNORE.`,
    );
  }
  if (ignoreConfig.enabled) {
    console.log(
      `[info] MOUNT_IGNORE active: local-only under ${ignoreConfig.root} ` +
        `(${ignoreConfig.ignore.patterns.join(", ")})`,
    );
    for (const exclusion of ignoreConfig.ignore.ineffectiveExclusions) {
      console.log(
        `[warn] MOUNT_IGNORE exclusion ${exclusion} has no effect: a directory ` +
          `above it is already local-only.`,
      );
    }
  }

  const store = resolveStore(parseStoreMode(process.env.COMPUTERD_DB), mountPoint);
  console.log(
    `[info] COMPUTERD_DB resolved to store=${store.kind}${
      store.kind === "file" ? ` path=${store.path} fresh=${store.fresh}` : ""
    }`,
  );

  const desktop = new DesktopController(parseDesktopEnv(process.env));
  if (desktop.enabled) {
    await desktop.start();
    const st = desktop.getStatusSync();
    console.log(
      `[info] desktop active: display=${st.display} resolution=${st.width}x${st.height}x${st.depth} vnc=${st.vncPort ?? "off"} novnc=${st.noVncPort ?? "off"}`,
    );
  }

  const {
    vfs,
    db,
    checkpoint: checkpointStore,
    storeStats,
    close: closeStore,
  } = await createNodeVirtualFileSystem({ store });
  const info: ComputerdInfo = {
    backend,
    mountPoint,
    port,
    store,
    ignore: describeMountIgnore(ignoreConfig),
    desktop: desktop.getStatusSync(),
  };

  let fuse: FuseMount | undefined;
  let shim: ShimMount | undefined;
  if (backend.kind !== "none") {
    vfs.mkdirSync(mountPoint, { recursive: true });
    await mkdir(mountPoint, { recursive: true });

    if (backend.kind === "shim") {
      shim = await mountShim({ vfs, mountPoint });
      fuse = shim;
    } else {
      if (ignoreConfig.enabled) {
        await mkdir(ignoreConfig.root, { recursive: true });
      }
      fuse = await mountFuse({
        backend,
        mountPoint,
        vfs,
        ...(ignoreConfig.enabled
          ? {
              localPaths: {
                root: ignoreConfig.root,
                ignore: ignoreConfig.ignore,
                mountPoint,
              },
            }
          : {}),
      });
    }
  }

  const logMaxBytesEnv = process.env.EXEC_LOG_MAX_BYTES;
  let logMaxBytesOverride: number | undefined;
  if (logMaxBytesEnv !== undefined && logMaxBytesEnv !== "") {
    const parsed = Number(logMaxBytesEnv);
    if (!Number.isFinite(parsed) || parsed <= 0 || !Number.isInteger(parsed)) {
      throw new Error(
        `EXEC_LOG_MAX_BYTES must be a positive integer; got ${JSON.stringify(logMaxBytesEnv)}`,
      );
    }
    logMaxBytesOverride = parsed;
  }
  const shellEnv = process.env.EXEC_SHELL;
  let shellOverride: string | undefined;
  if (shellEnv !== undefined && shellEnv !== "") {
    if (!shellEnv.startsWith("/")) {
      throw new Error(`EXEC_SHELL must be an absolute path; got ${JSON.stringify(shellEnv)}`);
    }
    shellOverride = shellEnv;
  }
  const runner = new Runner({
    db,
    ...(fuse !== undefined ? { cwd: mountPoint } : {}),
    ...(desktop.enabled ? { env: { DISPLAY: desktop.display } } : {}),
    ...(logMaxBytesOverride !== undefined ? { logMaxBytes: logMaxBytesOverride } : {}),
    ...(shellOverride !== undefined ? { shell: shellOverride } : {}),
  });
  const rpcRunner: RunnerLike = {
    exec(command, options) {
      const handle = runner.exec(command, options);
      return { id: handle.id, events: dropHeartbeats(handle.events) };
    },
    get(id, options) {
      const handle = runner.get(id, options);
      return { id: handle.id, events: dropHeartbeats(handle.events) };
    },
    kill: runner.kill.bind(runner),
    dispose: runner.dispose.bind(runner),
  };
  const rpc = createWorkspaceServer(db, rpcRunner, {
    desktop,
    ...(shim
      ? {
          afterApply: () => shim.flush(),
          beforeFetch: () => shim.reconcileNow(),
        }
      : {}),
  });
  const http = createHTTPServer(
    info,
    rpc,
    clientSecret,
    () => {
      const { sizeBytes, freelistCount } = storeStats();
      return {
        ...collectDbStats(db),
        ...(fuse?.getBufferStats?.() ?? {}),
        ...(fuse?.getLocalPathStats === undefined ? {} : { localPaths: fuse.getLocalPathStats() }),
        store_size_bytes: sizeBytes,
        store_freelist_count: freelistCount,
      };
    },
    checkpointStore,
    desktop,
  );

  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;

    try {
      await http.close();
    } catch (error) {
      console.error(error);
    }
    try {
      runner.disposeAll();
    } catch (error) {
      console.error(error);
    }
    try {
      await desktop.stop();
    } catch (error) {
      console.error(error);
    }

    if (fuse !== undefined) {
      await unmount(fuse);
    }
    try {
      closeStore();
    } catch (error) {
      console.error("failed to close the store:", error);
    }
    teardownLogging();
    process.exit(signal === "SIGINT" ? 130 : 143);
  };

  process.once("SIGINT", (signal) => void shutdown(signal));
  process.once("SIGTERM", (signal) => void shutdown(signal));

  await new Promise<void>((resolve) => {
    http.server.listen(port, HOST, () => {
      const address = http.server.address();

      const boundPort = typeof address === "object" && address !== null ? address.port : port;
      info.port = boundPort;
      const mountLabel = backend.kind === "none" ? "(disabled)" : mountPoint;
      console.log(
        `computerd listening on ${HOST}:${boundPort} mount=${mountLabel} backend=${backend.kind}`,
      );
      resolve();
    });
  });
}

async function unmount(fuse: FuseMount): Promise<void> {
  try {
    await fuse.unmount();
  } catch (error) {
    console.error("failed to unmount FUSE:", error instanceof Error ? error.message : error);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
