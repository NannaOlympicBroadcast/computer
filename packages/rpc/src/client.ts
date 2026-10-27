// Client-side adapter: turn a WebSocket URL into a typed SyncRPC or
// WorkspaceRPC stub. Capnweb's newWebSocketRpcSession does the actual
// dial; we own the connection lifecycle and expose close() and closed
// for clean teardown and reconnect detection.

import { newWebSocketRpcSession, type RpcStub } from "capnweb";

import type { SyncRPC, WorkspaceRPC } from "./interface.js";

export interface RPCEvent {
  rpc: keyof SyncRPC;
  durationMs: number;
  ok: boolean;
  code?: string;
}

export interface ClientOptions {
  // WebSocket URL. Typically ws://container-host:45678/api.
  url: string;
  // Optional bearer secret sent as `Authorization: Bearer <secret>`.
  secret?: string;
  // Optional custom HTTP headers sent during the WebSocket handshake.
  headers?: Record<string, string>;
  // Optional WebSocket constructor. Defaults to the global WebSocket.
  WebSocketImpl?: typeof WebSocket;
  // Fired once per RPC with timing + outcome.
  onRPCEvent?: (event: RPCEvent) => void;
}

export interface SyncClient extends SyncRPC {
  // Close the WebSocket and tear down the stub. Idempotent.
  close(): Promise<void>;
  // Resolves when the underlying WebSocket closes or errors.
  readonly closed: Promise<void>;
}

function openWebSocket(options: {
  url: string;
  secret?: string;
  headers?: Record<string, string>;
  WebSocketImpl?: typeof WebSocket;
}): { ws: WebSocket; closed: Promise<void> } {
  const WS = options.WebSocketImpl ?? WebSocket;
  const headers: Record<string, string> = {
    ...options.headers,
    ...(options.secret !== undefined && options.secret !== ""
      ? { Authorization: `Bearer ${options.secret}` }
      : {}),
  };
  let ws: WebSocket;
  if (Object.keys(headers).length > 0) {
    try {
      ws = new (WS as unknown as new (
        url: string,
        opts: { headers: Record<string, string> },
      ) => WebSocket)(options.url, { headers });
    } catch {
      ws = new WS(options.url);
    }
  } else {
    ws = new WS(options.url);
  }
  const closed = new Promise<void>((resolve) => {
    const target = ws as unknown as EventTarget & { readyState?: number };
    if (typeof target.readyState === "number" && target.readyState >= 2) {
      resolve();
      return;
    }
    const done = () => resolve();
    target.addEventListener("close", done, { once: true });
    target.addEventListener("error", done, { once: true });
  });
  return { ws, closed };
}

function closeSocket(target: unknown, ws: WebSocket): Promise<void> {
  try {
    (target as Disposable)[Symbol.dispose]?.();
  } catch {
    // already disposed; idempotent
  }
  return new Promise<void>((resolve) => {
    const w = ws as unknown as { readyState: number; close: () => void };
    if (w.readyState >= 2) {
      resolve();
      return;
    }
    (ws as unknown as EventTarget).addEventListener("close", () => resolve(), {
      once: true,
    });
    w.close();
    setTimeout(resolve, 200);
  });
}

// Open a SyncRPC session against `url`. The first call to any
// method on the returned stub queues until the WebSocket reaches
// readyState OPEN; capnweb's transport handles that.
export function createSyncClient(options: ClientOptions): SyncClient {
  const { ws, closed } = openWebSocket(options);
  const stub = newWebSocketRpcSession(ws as unknown as globalThis.WebSocket) as RpcStub<SyncRPC>;
  const onEvent = options.onRPCEvent;
  return new Proxy(stub, {
    get(target, prop, receiver) {
      if (prop === "close") {
        return () => closeSocket(target, ws);
      }
      if (prop === "closed") {
        return closed;
      }
      const value = Reflect.get(target, prop, receiver);
      if (onEvent === undefined || typeof prop !== "string") return value;
      return (...args: unknown[]) => {
        const start = Date.now();
        const result = (value as (...a: unknown[]) => unknown)(...args);
        if (result && typeof (result as { then?: unknown }).then === "function") {
          return (result as Promise<unknown>).then(
            (v) => {
              onEvent({ rpc: prop as keyof SyncRPC, durationMs: Date.now() - start, ok: true });
              return v;
            },
            (err) => {
              onEvent({
                rpc: prop as keyof SyncRPC,
                durationMs: Date.now() - start,
                ok: false,
                code: (err as { code?: string })?.code,
              });
              throw err;
            },
          );
        }
        onEvent({ rpc: prop as keyof SyncRPC, durationMs: Date.now() - start, ok: true });
        return result;
      };
    },
  }) as unknown as SyncClient;
}

export interface WorkspaceClientOptions {
  url: string;
  secret?: string;
  headers?: Record<string, string>;
  WebSocketImpl?: typeof WebSocket;
}

export interface WorkspaceClient extends WorkspaceRPC {
  close(): Promise<void>;
  readonly closed: Promise<void>;
}

// Open a WorkspaceRPC session. Callers reach the sync half via `.sync`,
// the shell half via `.shell`, and the desktop half via `.desktop`.
export function createWorkspaceClient(options: WorkspaceClientOptions): WorkspaceClient {
  const { ws, closed } = openWebSocket(options);
  const stub = newWebSocketRpcSession(
    ws as unknown as globalThis.WebSocket,
  ) as RpcStub<WorkspaceRPC>;
  return new Proxy(stub, {
    get(target, prop, receiver) {
      if (prop === "close") {
        return () => closeSocket(target, ws);
      }
      if (prop === "closed") {
        return closed;
      }
      return Reflect.get(target, prop, receiver);
    },
  }) as unknown as WorkspaceClient;
}
