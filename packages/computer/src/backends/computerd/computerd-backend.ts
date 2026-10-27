// Public surface of @cloudflare/computer/backends/computerd.
//
// Backends that run a Workspace without Cloudflare. Neither needs
// workerd, a Durable Object, or a Container binding:
//
//   - ComputerdBackend dials a `computerd` daemon that is already
//     running at an HTTP URL (a local process, a Docker container you
//     started yourself, a VM, a Kubernetes pod).
//   - DockerContainerBackend starts a `computerd` Docker container
//     through the local `docker` CLI, connects to it, and removes it
//     when the Workspace closes. Pass `desktop` to run the desktop
//     image (Xvfb, Fluxbox, VNC, noVNC) and enable `workspace.desktop`.
//
// Both reach the daemon over the same capnweb WebSocket the Cloudflare
// container backends use, so sync, exec, and desktop calls behave the
// same.
//
// Status: experimental.

import { createWorkspaceClient } from "@cloudflare/computer-rpc/client";

import type { BackendHandle, WorkspaceBackend } from "../../backend.js";
import { startHeartbeat } from "../../heartbeat.js";
import { WorkspaceTransportError } from "../../transport-failure.js";

export interface ComputerdBackendOptions {
  // Stable id used to address this backend. Defaults to "computerd".
  id?: string;
  // Base URL of computerd, for example `http://127.0.0.1:45678`.
  // `ws://` and `wss://` URLs are accepted too.
  url: string;
  // Bearer secret computerd was started with (RPC_CLIENT_SECRET).
  secret?: string;
  // Milliseconds to wait for computerd to answer /health. Default 30s.
  readyTimeoutMs?: number;
  // Heartbeat interval. 0 disables it. Default 30s.
  heartbeatIntervalMs?: number;
  // Heartbeat timeout in milliseconds. Default 10s.
  heartbeatTimeoutMs?: number;
  // Skip the /health poll, for a daemon known to be up.
  probeHealth?: boolean;
  // Description shown to a model next to the exec tool.
  description?: string;
}

interface ComputerdInfoResponse {
  ignore?: { patterns?: readonly string[]; root?: string };
}

const DEFAULT_READY_TIMEOUT_MS = 30_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 10_000;

function httpBase(url: string): string {
  const parsed = new URL(url);
  if (parsed.protocol === "ws:") parsed.protocol = "http:";
  if (parsed.protocol === "wss:") parsed.protocol = "https:";
  parsed.pathname = parsed.pathname.replace(/\/(api|health)?\/?$/, "");
  parsed.search = "";
  return parsed.toString().replace(/\/$/, "");
}

function wsApiUrl(url: string): string {
  const base = new URL(httpBase(url));
  base.protocol = base.protocol === "https:" ? "wss:" : "ws:";
  return `${base.toString().replace(/\/$/, "")}/api`;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitForComputerd(
  url: string,
  secret: string | undefined,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  let delay = 100;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${httpBase(url)}/health`, {
        method: "HEAD",
        signal: AbortSignal.timeout(2_000),
        ...(secret ? { headers: { Authorization: `Bearer ${secret}` } } : {}),
      });
      void res.body?.cancel();
      if (res.ok) return;
      lastError = new Error(`computerd /health returned ${res.status}`);
    } catch (error) {
      lastError = error;
    }
    await sleep(delay);
    delay = Math.min(delay * 2, 1_000);
  }
  throw new WorkspaceTransportError(
    `computerd at ${httpBase(url)} was not ready within ${timeoutMs}ms: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
    { cause: lastError },
  );
}

export class ComputerdBackend implements WorkspaceBackend {
  readonly id: string;
  readonly type = "computerd";
  readonly description?: string;
  readonly #options: ComputerdBackendOptions;

  constructor(options: ComputerdBackendOptions) {
    this.id = options.id ?? "computerd";
    this.#options = options;
    if (options.description !== undefined) this.description = options.description;
    // Fail on a malformed URL at construction rather than first use.
    httpBase(options.url);
  }

  async connect(): Promise<BackendHandle> {
    const options = this.#options;
    if (options.probeHealth !== false) {
      await waitForComputerd(
        options.url,
        options.secret,
        options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS,
      );
    }
    const info = await this.#readInfo();
    const client = createWorkspaceClient({
      url: wsApiUrl(options.url),
      ...(options.secret ? { secret: options.secret } : {}),
    });
    let closedFlag = false;
    let stopHeartbeat: (() => void) | undefined;
    const close = async (): Promise<void> => {
      if (closedFlag) return;
      closedFlag = true;
      stopHeartbeat?.();
      await client.close();
    };
    const intervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    const timeoutMs = options.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS;
    if (intervalMs > 0) {
      stopHeartbeat = startHeartbeat({
        intervalMs,
        ping: () =>
          Promise.race([
            client.sync.watermarks(),
            sleep(timeoutMs).then(() => {
              throw new Error(`computerd heartbeat timed out after ${timeoutMs}ms`);
            }),
          ]),
        onFailure: () => {
          void close();
        },
      });
    }
    const patterns = info?.ignore?.patterns;
    return {
      rpc: client,
      closed: client.closed.then(() => {
        closedFlag = true;
        stopHeartbeat?.();
      }),
      ...(patterns === undefined
        ? {}
        : { ignore: { patterns, root: info?.ignore?.root, supported: true } }),
      close,
    };
  }

  async #readInfo(): Promise<ComputerdInfoResponse | undefined> {
    try {
      const res = await fetch(`${httpBase(this.#options.url)}/__computerd/info`, {
        signal: AbortSignal.timeout(5_000),
        ...(this.#options.secret
          ? { headers: { Authorization: `Bearer ${this.#options.secret}` } }
          : {}),
      });
      if (!res.ok) {
        void res.body?.cancel();
        return undefined;
      }
      return (await res.json()) as ComputerdInfoResponse;
    } catch {
      // The info endpoint is advisory. A daemon that predates it, or
      // that hides it behind auth, still serves /api.
      return undefined;
    }
  }
}
