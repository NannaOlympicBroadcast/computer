// Server-side adapter: a SQLite-backed Database becomes a SyncRPC.
//
// The DO uses this to expose its sync surface to the container, and
// the in-container computerd uses it to expose its mirror to
// the DO. Same code on both ends; what differs is who calls whom.

import {
  applyChangesSync,
  type ChangeCursor,
  type ChangeEntry,
  coalesceChanges,
  compareChangeCursors,
  currentRev,
  type Database,
  decodeChangePack,
  encodeChangePack,
  fetchObjects,
  hasObjects,
  materialiseChange,
  planBlock,
  readFetchCursor,
  readWatermark,
  stageBlob,
  writeFetchCursor,
} from "@cloudflare/dofs";
import { newWebSocketRpcSession, RpcTarget } from "capnweb";

import { trackStub, untrackStub } from "./debug.js";
import type {
  DesktopClickInput,
  DesktopDragInput,
  DesktopKeyInput,
  DesktopMouseButton,
  DesktopMouseButtonInput,
  DesktopMoveInput,
  DesktopPoint,
  DesktopRPC,
  DesktopScreenSize,
  DesktopScreenshotOptions,
  DesktopScreenshotResult,
  DesktopScrollInput,
  DesktopStartOptions,
  DesktopStatus,
  DesktopTypeInput,
  DesktopWindowInfo,
  ExecEvent,
  ShellRPC,
  SyncRPC,
  WorkspaceRPC,
} from "./interface.js";

// Subset of computerd's Runner that the shell server needs. Defining
// the shape here (instead of importing the concrete class) keeps
// computer-rpc free of a computerd dependency — the package builds and
// runs without computerd's process-supervision code on the path.
export interface RunnerLike {
  exec(
    command: string,
    options?: {
      id?: string;
      cwd?: string;
      timeoutMs?: number;
      env?: Record<string, string>;
      stdin?: Uint8Array;
    },
  ): {
    id: string;
    events: ReadableStream<ExecEvent>;
  };
  get(
    id: string,
    options?: { after?: number | "tail" },
  ): {
    id: string;
    events: ReadableStream<ExecEvent>;
  };
  kill(id: string, signal?: "SIGTERM" | "SIGKILL" | "SIGINT" | "SIGHUP"): void;
  dispose(id: string): void;
}

// Driver interface implemented by computerd's DesktopController (or test fakes).
export type DesktopLike = DesktopRPC;

export interface ServerOptions {
  ignore?: string[];
  /**
   * Optional desktop controller exposed as `.desktop` on the composite
   * WorkspaceRPC server. When omitted, `.desktop.status()` reports
   * `enabled: false` and active desktop operations reject with ENOSYS.
   */
  desktop?: DesktopLike;
  /**
   * Optional hook fired inside the SyncRPC `push` handler, right
   * after a successful peer batch has been committed. Resolved
   * before `push()` returns to the caller. Used by computerd to settle
   * the userspace shim layer so a subsequent `shell.exec` sees the
   * just-pushed files on disk.
   *
   * Errors are caught and logged — the push itself already
   * succeeded; the caller should not see a flush failure as a
   * push failure.
   */
  afterApply?: () => void | Promise<void>;
  /**
   * Optional hook fired inside the SyncRPC `fetchChanges` handler,
   * right before the receiver computes the change set the puller
   * will see. Resolved before any entries stream. Used by computerd to
   * settle the userspace shim's disk→VFS reconcile so a
   * `Workspace.pull()` issued right after `shell.exec` returns the
   * files the exec'd process wrote, without waiting on the shim's
   * periodic poll.
   *
   * Fires on every fetch, including ones that would otherwise
   * stream zero entries — the hook is what produces the entries in
   * the first place. Errors are caught and logged; a hook failure
   * must not fail the fetch.
   */
  beforeFetch?: () => void | Promise<void>;
}

class SyncRPCServer extends RpcTarget implements SyncRPC {
  constructor(
    private readonly db: Database,
    private readonly options: Required<Pick<ServerOptions, "ignore">> &
      Pick<ServerOptions, "afterApply" | "beforeFetch">,
  ) {
    super();
    trackStub(this);
  }

  [Symbol.dispose](): void {
    untrackStub(this);
  }

  async push(input: {
    senderRev: number;
    senderCursor?: ChangeCursor;
    changes: ReadableStream<ChangeEntry>;
  }): Promise<{ rev: number; applied?: number; appliedPushCursor: ChangeCursor }> {
    const entries: ChangeEntry[] = [];
    const reader = input.changes.getReader();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        entries.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    const senderCursor = input.senderCursor ?? { rev: input.senderRev, path: null };
    const isPeer = senderCursor.rev > 0;
    this.db.transactionSync(() => {
      applyChangesSync(this.db, entries, new Map(), {
        source: isPeer ? "upstream" : "local",
        receivedCursor: readFetchCursor(this.db),
      });
      if (isPeer && compareChangeCursors(senderCursor, readFetchCursor(this.db)) > 0) {
        writeFetchCursor(this.db, senderCursor);
      }
    });
    if (this.options.afterApply !== undefined && entries.length > 0) {
      if (isPeer) {
        await this.options.afterApply();
      } else {
        try {
          await this.options.afterApply();
        } catch (err) {
          console.warn("[SyncRPCServer] afterApply hook failed for external push:", err);
        }
      }
    }
    return {
      rev: currentRev(this.db),
      applied: entries.length,
      appliedPushCursor: isPeer ? senderCursor : { rev: 0, path: null },
    };
  }

  async fetchChanges(input: {
    after?: ChangeCursor;
    through?: ChangeCursor;
    ignore?: string[];
  }): Promise<{
    currentCursor: ChangeCursor;
    appliedPushCursor: ChangeCursor;
    stream: ReadableStream<ChangeEntry>;
  }> {
    if (this.options.beforeFetch !== undefined) {
      try {
        await this.options.beforeFetch();
      } catch (err) {
        console.warn("[SyncRPCServer] beforeFetch hook failed:", err);
      }
    }
    const after = input.after ?? { rev: 0, path: null };
    const ignore = input.ignore ?? this.options.ignore;
    const snapshotRev = currentRev(this.db);
    const snapshotCursor = { rev: snapshotRev, path: null };
    const currentCursor =
      input.through !== undefined && compareChangeCursors(input.through, snapshotCursor) < 0
        ? input.through
        : snapshotCursor;
    return {
      currentCursor,
      appliedPushCursor: readFetchCursor(this.db),
      stream: iterableToReadableStream(
        coalesceChanges(this.db, after, { ignore, through: currentCursor }),
      ),
    };
  }

  async fetchChangePack(input: {
    after?: ChangeCursor;
    through?: ChangeCursor;
    ignore?: string[];
    maxEntries: number;
    maxBytes: number;
    generation: string;
  }): Promise<{
    cursor: ChangeCursor;
    drained: boolean;
    entryCount: number;
    appliedPushCursor: ChangeCursor;
    stream: ReadableStream<Uint8Array>;
  }> {
    if (this.options.beforeFetch !== undefined) {
      try {
        await this.options.beforeFetch();
      } catch (err) {
        console.warn("[SyncRPCServer] beforeFetch hook failed:", err);
      }
    }
    const after = input.after ?? { rev: 0, path: null };
    const ignore = input.ignore ?? this.options.ignore;
    const snapshotCursor = { rev: currentRev(this.db), path: null };
    const target =
      input.through !== undefined && compareChangeCursors(input.through, snapshotCursor) < 0
        ? input.through
        : snapshotCursor;

    const block = await planBlock(this.db, {
      after,
      through: target,
      profile: { maxEntries: input.maxEntries, maxBytes: input.maxBytes },
      ...(ignore === undefined ? {} : { ignore }),
    });

    return {
      cursor: block.cursor,
      drained: block.drained,
      entryCount: block.entries.length,
      appliedPushCursor: readFetchCursor(this.db),
      stream: encodeChangePack(this.db, {
        block,
        after,
        target,
        generation: input.generation,
      }),
    };
  }

  async applyChangePack(input: {
    generation: string;
    stream: ReadableStream<Uint8Array>;
  }): Promise<{
    appliedPushCursor: ChangeCursor;
    applied: number;
    entryCount: number;
  }> {
    const decoded = await decodeChangePack(input.stream, {
      expectGeneration: input.generation,
    });
    for (const [key, bytes] of decoded.objects) {
      stageBlob(this.db, hexToBytes(key), bytes, Date.now());
    }
    const result = applyChangesSync(this.db, decoded.entries, new Map(), {
      source: "upstream",
      receivedCursor: readFetchCursor(this.db),
    });
    writeFetchCursor(this.db, decoded.footer.blockCursor);
    if (this.options.afterApply !== undefined && decoded.entries.length > 0) {
      await this.options.afterApply();
    }
    return {
      appliedPushCursor: decoded.footer.blockCursor,
      applied: result.applied,
      entryCount: decoded.entries.length,
    };
  }

  async readEntry(path: string): Promise<ChangeEntry | null> {
    return materialiseChange(this.db, path);
  }

  async watermarks(input: { settle?: boolean } = {}): Promise<{
    currentRev: number;
    pushRev: number;
    fetchCursor: ChangeCursor;
  }> {
    if (input.settle === true && this.options.beforeFetch !== undefined) {
      await this.options.beforeFetch();
    }
    return {
      currentRev: currentRev(this.db),
      pushRev: readWatermark(this.db, "pushRev"),
      fetchCursor: readFetchCursor(this.db),
    };
  }

  async hasObjects(hashes: Uint8Array[]): Promise<Uint8Array[]> {
    return hasObjects(this.db, hashes);
  }

  fetchObjects(hashes: Uint8Array[]): ReadableStream<{ hash: Uint8Array; bytes: Uint8Array }> {
    return iterableToReadableStream(fetchObjects(this.db, hashes));
  }

  async pushObjects(
    objects: ReadableStream<{ hash: Uint8Array; bytes: Uint8Array }>,
  ): Promise<void> {
    const reader = objects.getReader();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        stageBlob(this.db, value.hash, value.bytes, Date.now());
      }
    } finally {
      reader.releaseLock();
    }
  }
}

class ShellRPCServer extends RpcTarget implements ShellRPC {
  constructor(private readonly runner: RunnerLike) {
    super();
    trackStub(this);
  }

  [Symbol.dispose](): void {
    untrackStub(this);
  }

  async exec(input: {
    source: string;
    cwd?: string;
    id?: string;
    input?: unknown;
    timeoutMs?: number;
    env?: Record<string, string>;
    stdin?: Uint8Array;
  }): Promise<{
    id: string;
    events: ReadableStream<ExecEvent>;
  }> {
    return this.runner.exec(input.source, {
      id: input.id,
      cwd: input.cwd,
      timeoutMs: input.timeoutMs,
      env: input.env,
      stdin: input.stdin,
    });
  }

  async getExec(input: { id: string; after?: number | "tail" }): Promise<{
    id: string;
    events: ReadableStream<ExecEvent>;
  }> {
    return this.runner.get(input.id, { after: input.after });
  }

  async killExec(input: {
    id: string;
    signal?: "SIGTERM" | "SIGKILL" | "SIGINT" | "SIGHUP";
  }): Promise<void> {
    this.runner.kill(input.id, input.signal);
  }

  async disposeExec(input: { id: string }): Promise<void> {
    this.runner.dispose(input.id);
  }
}

function createDisabledDesktopError(): Error & { code: string } {
  const err = new Error("Desktop environment is not enabled on this server.") as Error & {
    code: string;
  };
  err.code = "ENOSYS";
  return err;
}

const DISABLED_DESKTOP: DesktopLike = {
  async status(): Promise<DesktopStatus> {
    return {
      enabled: false,
      running: false,
      display: ":99",
      width: 1280,
      height: 720,
      depth: 24,
      vncPort: null,
      noVncPort: null,
      windowManager: null,
    };
  },
  async start(): Promise<DesktopStatus> {
    throw createDisabledDesktopError();
  },
  async stop(): Promise<DesktopStatus> {
    return this.status();
  },
  async screenshot(): Promise<DesktopScreenshotResult> {
    throw createDisabledDesktopError();
  },
  async click(): Promise<void> {
    throw createDisabledDesktopError();
  },
  async doubleClick(): Promise<void> {
    throw createDisabledDesktopError();
  },
  async tripleClick(): Promise<void> {
    throw createDisabledDesktopError();
  },
  async rightClick(): Promise<void> {
    throw createDisabledDesktopError();
  },
  async middleClick(): Promise<void> {
    throw createDisabledDesktopError();
  },
  async mouseDown(): Promise<void> {
    throw createDisabledDesktopError();
  },
  async mouseUp(): Promise<void> {
    throw createDisabledDesktopError();
  },
  async move(): Promise<void> {
    throw createDisabledDesktopError();
  },
  async drag(): Promise<void> {
    throw createDisabledDesktopError();
  },
  async scroll(): Promise<void> {
    throw createDisabledDesktopError();
  },
  async type(): Promise<void> {
    throw createDisabledDesktopError();
  },
  async key(): Promise<void> {
    throw createDisabledDesktopError();
  },
  async cursorPosition(): Promise<DesktopPoint> {
    throw createDisabledDesktopError();
  },
  async screenSize(): Promise<DesktopScreenSize> {
    throw createDisabledDesktopError();
  },
  async windows(): Promise<DesktopWindowInfo[]> {
    throw createDisabledDesktopError();
  },
  async focusWindow(): Promise<void> {
    throw createDisabledDesktopError();
  },
  async clipboardRead(): Promise<string> {
    throw createDisabledDesktopError();
  },
  async clipboardWrite(): Promise<void> {
    throw createDisabledDesktopError();
  },
  async wait(input: { durationMs: number }): Promise<void> {
    const ms = Math.max(0, Math.min(input.durationMs, 60_000));
    await new Promise<void>((resolve) => setTimeout(resolve, ms));
  },
};

class DesktopRPCServer extends RpcTarget implements DesktopRPC {
  constructor(private readonly desktop: DesktopLike) {
    super();
    trackStub(this);
  }

  [Symbol.dispose](): void {
    untrackStub(this);
  }

  status(): Promise<DesktopStatus> {
    return this.desktop.status();
  }

  start(options?: DesktopStartOptions): Promise<DesktopStatus> {
    return this.desktop.start(options);
  }

  stop(): Promise<DesktopStatus> {
    return this.desktop.stop();
  }

  screenshot(options?: DesktopScreenshotOptions): Promise<DesktopScreenshotResult> {
    return this.desktop.screenshot(options);
  }

  click(input: DesktopClickInput): Promise<void> {
    return this.desktop.click(input);
  }

  doubleClick(input: { x?: number; y?: number; button?: DesktopMouseButton }): Promise<void> {
    return this.desktop.doubleClick(input);
  }

  tripleClick(input: { x?: number; y?: number; button?: DesktopMouseButton }): Promise<void> {
    return this.desktop.tripleClick(input);
  }

  rightClick(input: { x?: number; y?: number }): Promise<void> {
    return this.desktop.rightClick(input);
  }

  middleClick(input: { x?: number; y?: number }): Promise<void> {
    return this.desktop.middleClick(input);
  }

  mouseDown(input?: DesktopMouseButtonInput): Promise<void> {
    return this.desktop.mouseDown(input);
  }

  mouseUp(input?: DesktopMouseButtonInput): Promise<void> {
    return this.desktop.mouseUp(input);
  }

  move(input: DesktopMoveInput): Promise<void> {
    return this.desktop.move(input);
  }

  drag(input: DesktopDragInput): Promise<void> {
    return this.desktop.drag(input);
  }

  scroll(input: DesktopScrollInput): Promise<void> {
    return this.desktop.scroll(input);
  }

  type(input: DesktopTypeInput): Promise<void> {
    return this.desktop.type(input);
  }

  key(input: DesktopKeyInput): Promise<void> {
    return this.desktop.key(input);
  }

  cursorPosition(): Promise<DesktopPoint> {
    return this.desktop.cursorPosition();
  }

  screenSize(): Promise<DesktopScreenSize> {
    return this.desktop.screenSize();
  }

  windows(): Promise<DesktopWindowInfo[]> {
    return this.desktop.windows();
  }

  focusWindow(input: { id?: string; title?: string }): Promise<void> {
    return this.desktop.focusWindow(input);
  }

  clipboardRead(): Promise<string> {
    return this.desktop.clipboardRead();
  }

  clipboardWrite(input: { text: string }): Promise<void> {
    return this.desktop.clipboardWrite(input);
  }

  wait(input: { durationMs: number }): Promise<void> {
    return this.desktop.wait(input);
  }
}

// Composite server: exposes sync, shell, and desktop as named getters on
// one stub. Capnweb walks the property tree on demand, so callers only
// pay for the surface they reach.
class WorkspaceRPCServer extends RpcTarget implements WorkspaceRPC {
  // sync / shell / desktop are exposed as getters — capnweb's RpcTarget
  // refuses to traverse plain instance properties (the readLoop raises
  // 'instance properties cannot be accessed over RPC'). Getters look
  // like methods to the dispatch path.
  #sync: SyncRPC;
  #shell: ShellRPC;
  #desktopLike: DesktopLike | undefined;
  #desktop: DesktopRPC | undefined;
  constructor(sync: SyncRPC, shell: ShellRPC, desktopLike?: DesktopLike) {
    super();
    this.#sync = sync;
    this.#shell = shell;
    this.#desktopLike = desktopLike;
    trackStub(this);
  }

  [Symbol.dispose](): void {
    (this.#desktop as unknown as Disposable | undefined)?.[Symbol.dispose]?.();
    untrackStub(this);
  }
  get sync(): SyncRPC {
    return this.#sync;
  }
  get shell(): ShellRPC {
    return this.#shell;
  }
  get desktop(): DesktopRPC {
    this.#desktop ??= createDesktopServer(this.#desktopLike);
    return this.#desktop;
  }
}

// Construct a SyncRPC bound to `db`. The carrier (HTTP server +
// WebSocketServer) is the caller's responsibility; this just hands
// back the object to mount on each connection via
// acceptWebSocketSession().
export function createSyncServer(db: Database, options: ServerOptions = {}): SyncRPC {
  return new SyncRPCServer(db, {
    ignore: options.ignore ?? [],
    afterApply: options.afterApply,
    beforeFetch: options.beforeFetch,
  });
}

// Construct a ShellRPC bound to a Runner. computerd holds the only
// Runner today; tests can pass a fake that implements RunnerLike.
export function createShellServer(runner: RunnerLike): ShellRPC {
  return new ShellRPCServer(runner);
}

// Construct a DesktopRPC bound to a DesktopLike controller.
export function createDesktopServer(desktop: DesktopLike = DISABLED_DESKTOP): DesktopRPC {
  return new DesktopRPCServer(desktop);
}

// Construct the composite WorkspaceRPC. The wire serves this on
// /api so clients reach `.sync`, `.shell`, and `.desktop` through one session.
export function createWorkspaceServer(
  db: Database,
  runner: RunnerLike,
  options: ServerOptions = {},
): WorkspaceRPC {
  return new WorkspaceRPCServer(
    createSyncServer(db, options),
    createShellServer(runner),
    options.desktop,
  );
}

// Attach a capnweb RPC session to a WHATWG-shaped WebSocket.
export function acceptWebSocketSession(
  ws: WebSocket | { addEventListener: WebSocket["addEventListener"] },
  rpc: SyncRPC | ShellRPC | DesktopRPC | WorkspaceRPC,
): void {
  newWebSocketRpcSession(ws as unknown as WebSocket, rpc as unknown as RpcTarget);
}

function iterableToReadableStream<T>(it: AsyncIterable<T>): ReadableStream<T> {
  const iterator = it[Symbol.asyncIterator]();
  return new ReadableStream<T>({
    async pull(controller) {
      const { value, done } = await iterator.next();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    async cancel(reason) {
      if (iterator.return) await iterator.return(reason as undefined);
    },
  });
}

// Pack object keys are hex; stageBlob wants the raw hash bytes.
function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}
