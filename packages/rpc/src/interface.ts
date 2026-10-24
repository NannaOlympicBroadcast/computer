// The wire contract for the workspace sync RPC. The DO side and the
// container-side computerd both implement this interface
// against a SQLite-backed VFS; the only thing that differs is which
// direction each method is called from.
//
// Naming summary:
//
//   push           — DO  → container.   Streams ChangeEntry.
//   pushObjects    — DO  → container.   Streams chunk bytes by hash.
//   fetchChanges   — DO  → container.   Streams ChangeEntry (request).
//   fetchObjects   — DO  → container.   Streams chunk bytes by hash (request).
//   hasObjects     — either probes the other. Returns the subset
//                    the receiver already holds.
//
// The exec / getExec / killExec / disposeExec surface hangs off a
// sibling ShellRPC interface, and desktop GUI operations hang off
// DesktopRPC. All compose under the top-level WorkspaceRPC, so the
// wire stub exposes one stable surface while the parts stay
// internally separable.

import type { ChangeCursor, ChangeEntry } from "@cloudflare/dofs";

export interface SyncRPC {
  // DO → container. Stream a coalesced batch of changes. Bytes are
  // not inline: the DO sends ChangeEntry records with chunk hashes,
  // the container calls back via hasObjects / asks for the missing
  // bytes through pushObjects. `senderRev` is the sender's
  // currentRev at the moment it captured the batch. The receiver
  // advances its fetch cursor to this completed rev after the apply
  // settles, and echoes that cursor back as `appliedPushCursor` so
  // the sender can assert applied covers pushed on every response.
  push(input: {
    senderRev: number;
    senderCursor?: ChangeCursor;
    changes: ReadableStream<ChangeEntry>;
  }): Promise<{
    rev: number;
    applied?: number;
    appliedPushCursor: ChangeCursor;
  }>;

  // Container ← DO. Stream every ChangeEntry after the supplied cursor,
  // alongside cursors used to drive the pull:
  //
  //   currentCursor  — the receiver's currentRev captured at the
  //                     start of the stream, with path=null to mark
  //                     the whole rev complete after a clean drain.
  //   appliedPushCursor — the receiver's cursor for sender changes
  //                       it has applied. The puller asserts this
  //                       covers local pushRev before draining,
  //                       mirroring the same check on push.
  //
  // Per-file entries carry (hash, size) chunk lists; no bytes inline.
  fetchChanges(input: {
    after?: ChangeCursor;
    through?: ChangeCursor;
    ignore?: string[];
  }): Promise<{
    currentCursor: ChangeCursor;
    appliedPushCursor: ChangeCursor;
    stream: ReadableStream<ChangeEntry>;
  }>;

  // Read the receiver's full sync watermark state. Cheap (three
  // SQL scalars) and read-only. Diagnostic surface for load
  // tests, dashboards, and the agent's exec stream when it
  // wants to wait for the wire to drain. The three values are:
  //
  //   currentRev  — latest rev stamped on any local mutation.
  //   pushRev     — highest rev already shipped to the upstream.
  //   fetchCursor — upstream fetch cursor, including same-rev path
  //                 progress.
  //
  // pushRev / fetchCursor only move when the receiver is acting as
  // a sync peer. Otherwise they sit at 0. Pass `settle: true` to run
  // the receiver's pre-fetch reconciliation before currentRev is read;
  // deferred command sync uses that as its durable target fence.
  watermarks(input?: { settle?: boolean }): Promise<{
    currentRev: number;
    pushRev: number;
    fetchCursor: ChangeCursor;
  }>;

  // Materialise the receiver's view of a single path as a
  // ChangeEntry. Returns null when the path doesn't exist and
  // hasn't been tombstoned. File entries carry chunk (hash,
  // size) pairs only; the caller follows up with hasObjects +
  // fetchObjects for the bytes. Used by interactive readers
  // that don't want to drive the full fetchChanges stream just
  // to look up one path.
  readEntry(path: string): Promise<ChangeEntry | null>;

  hasObjects(hashes: Uint8Array[]): Promise<Uint8Array[]>;

  // Container → DO direction of object transfer. Stream bytes for a
  // set of chunk hashes in request order. Throws EUNKNOWN_HASH if
  // any hash is unknown — callers must dedupe and probe first.
  fetchObjects(hashes: Uint8Array[]): ReadableStream<{ hash: Uint8Array; bytes: Uint8Array }>;

  // Bulk pull transport. Same cursor semantics as fetchChanges, but the
  // response is one gzip change pack carrying entries interleaved with
  // the objects they reference, rather than an entry stream the caller
  // must follow with hasObjects / fetchObjects round trips.
  //
  // Selected automatically for large cursor windows; see the pack
  // thresholds in @cloudflare/dofs. `maxEntries` and `maxBytes` bound
  // the block so one pack stays inside the receiver's CPU budget, and
  // `cursor` echoes the block cursor the pack's footer also carries.
  // Optional: a peer built before pack transport omits these, and the
  // engine falls back to entry mode when it finds them absent. That is
  // what lets the two sides be deployed in either order.
  fetchChangePack?(input: {
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
  }>;

  // Bulk push transport, the mirror of fetchChangePack. The receiver
  // decodes the pack, stages its objects, applies its entries, and
  // echoes the cursor it applied so the sender can advance only through
  // an acknowledgment.
  applyChangePack?(input: { generation: string; stream: ReadableStream<Uint8Array> }): Promise<{
    appliedPushCursor: ChangeCursor;
    applied: number;
    entryCount: number;
  }>;

  // DO → container direction of object transfer. The DO streams the
  // bytes the container reported missing (via hasObjects) during a
  // push. Pushed objects are addressable immediately by hash.
  pushObjects(objects: ReadableStream<{ hash: Uint8Array; bytes: Uint8Array }>): Promise<void>;
}

// Process supervision surface. Lives alongside SyncRPC. computerd's
// Runner is the concrete implementation today; the interface keeps
// that dependency out of the wire contract.
export interface ShellRPC {
  // Spawn a command in the container. Returns an id (caller-
  // supplied or runner-minted) and a ReadableStream of ExecEvents.
  // Capnweb streams handle backpressure end-to-end; consumer-side
  // slowness propagates to the spawned process via the kernel pipe.
  exec(input: {
    source: string;
    cwd?: string;
    id?: string;
    // Structured value handed to a callable backend. Command
    // backends ignore it; the caller only sends it to backends that
    // declare themselves callable.
    input?: unknown;
    // Per-call timeout in milliseconds. Past this duration the
    // container sends SIGTERM (then SIGKILL after a short grace).
    // 0 disables the timeout. Omit to use the runner's default
    // (typically 320_000).
    timeoutMs?: number;
    // Environment variables inherited by this command only.
    env?: Record<string, string>;
    // Standard input bytes fed to the command.
    stdin?: Uint8Array;
  }): Promise<{
    id: string;
    events: ReadableStream<ExecEvent>;
  }>;

  // Reattach to an in-flight or recently-completed exec by id.
  // Pass `after` to resume from a known seq; "tail" yields only
  // future events; omit to receive every event from the start.
  getExec(input: { id: string; after?: number | "tail" }): Promise<{
    id: string;
    events: ReadableStream<ExecEvent>;
  }>;

  // Signal a running exec. No-op once the process has exited.
  killExec(input: {
    id: string;
    signal?: "SIGTERM" | "SIGKILL" | "SIGINT" | "SIGHUP";
  }): Promise<void>;

  // Release the event log for a completed exec. Future getExec on
  // the same id throws ENOENT.
  disposeExec(input: { id: string }): Promise<void>;
}

export type DesktopMouseButton =
  | "left"
  | "middle"
  | "right"
  | "back"
  | "forward"
  | 1
  | 2
  | 3
  | 4
  | 5;

export type DesktopScrollDirection = "up" | "down" | "left" | "right";

export type DesktopKeyAction = "press" | "down" | "up";

export interface DesktopPoint {
  x: number;
  y: number;
  screen?: number;
}

export interface DesktopRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DesktopScreenshotOptions {
  format?: "png" | "jpeg";
  quality?: number;
  region?: DesktopRegion;
  display?: string;
}

export interface DesktopScreenshotResult {
  data: Uint8Array;
  mimeType: "image/png" | "image/jpeg";
  width: number;
  height: number;
}

export interface DesktopClickInput {
  x?: number;
  y?: number;
  button?: DesktopMouseButton;
  count?: number;
  modifiers?: string[];
}

export interface DesktopMoveInput {
  x: number;
  y: number;
  relative?: boolean;
}

export interface DesktopMouseButtonInput {
  x?: number;
  y?: number;
  button?: DesktopMouseButton;
}

export interface DesktopDragInput {
  startX: number;
  startY: number;
  endX: number;
  endY: number;
  button?: DesktopMouseButton;
  steps?: number;
  durationMs?: number;
}

export interface DesktopScrollInput {
  x?: number;
  y?: number;
  direction?: DesktopScrollDirection;
  amount?: number;
  deltaX?: number;
  deltaY?: number;
}

export interface DesktopTypeInput {
  text: string;
  delayMs?: number;
}

export interface DesktopKeyInput {
  key: string;
  action?: DesktopKeyAction;
}

export interface DesktopScreenSize {
  width: number;
  height: number;
  display: string;
}

export interface DesktopWindowInfo {
  id: string;
  title: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  pid?: number;
  active?: boolean;
}

export interface DesktopStartOptions {
  width?: number;
  height?: number;
  depth?: number;
  display?: string;
}

export interface DesktopStatus {
  enabled: boolean;
  running: boolean;
  display: string;
  width: number;
  height: number;
  depth: number;
  vncPort: number | null;
  noVncPort: number | null;
  windowManager: string | null;
}

// Desktop GUI automation surface served by computerd when running in a
// desktop-enabled container (Xvfb + window manager + xdotool / scrot /
// x11vnc / noVNC).
export interface DesktopRPC {
  status(): Promise<DesktopStatus>;
  start(options?: DesktopStartOptions): Promise<DesktopStatus>;
  stop(): Promise<DesktopStatus>;
  screenshot(options?: DesktopScreenshotOptions): Promise<DesktopScreenshotResult>;
  click(input: DesktopClickInput): Promise<void>;
  doubleClick(input: { x?: number; y?: number; button?: DesktopMouseButton }): Promise<void>;
  tripleClick(input: { x?: number; y?: number; button?: DesktopMouseButton }): Promise<void>;
  rightClick(input: { x?: number; y?: number }): Promise<void>;
  middleClick(input: { x?: number; y?: number }): Promise<void>;
  mouseDown(input?: DesktopMouseButtonInput): Promise<void>;
  mouseUp(input?: DesktopMouseButtonInput): Promise<void>;
  move(input: DesktopMoveInput): Promise<void>;
  drag(input: DesktopDragInput): Promise<void>;
  scroll(input: DesktopScrollInput): Promise<void>;
  type(input: DesktopTypeInput): Promise<void>;
  key(input: DesktopKeyInput): Promise<void>;
  cursorPosition(): Promise<DesktopPoint>;
  screenSize(): Promise<DesktopScreenSize>;
  windows(): Promise<DesktopWindowInfo[]>;
  focusWindow(input: { id?: string; title?: string }): Promise<void>;
  clipboardRead(): Promise<string>;
  clipboardWrite(input: { text: string }): Promise<void>;
  wait(input: { durationMs: number }): Promise<void>;
}

// Composite stub. The wire serves one of these per session; the
// parts are independently testable. Host-side callers reach each
// via `.sync`, `.shell`, and `.desktop`.
export interface WorkspaceRPC {
  sync: SyncRPC;
  shell: ShellRPC;
  desktop?: DesktopRPC;
}

// Every event carries a per-id monotonic `seq`. The host-side
// Workspace.shell decodes value to string when the caller passes
// `encoding: "utf8"`.
export type ExecEvent =
  | { id: string; seq: number; name: "stdout"; value: Uint8Array }
  | { id: string; seq: number; name: "stderr"; value: Uint8Array }
  | { id: string; seq: number; name: "exit"; code: number; result?: unknown };

// Error codes carried over the wire. The client adapter rethrows as
// WorkspaceError preserving `code`, so application code can branch
// on err.code rather than parse messages.
export type WireErrorCode =
  | "ENOENT"
  | "ENOSYS"
  | "EUNKNOWN_HASH"
  | "ESHUTDOWN"
  | "EAUTH"
  | "EPROTOCOL"
  | "EEXEC_BUSY"
  | "ELOG_TRUNCATED";

export interface WireError {
  code: WireErrorCode;
  message: string;
}
