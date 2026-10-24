// Workspace desktop surface.
//
// `workspace.desktop` drives the GUI of a desktop-enabled computerd
// (Xvfb + a window manager + xdotool / scrot / x11vnc / noVNC), such as
// the container DockerContainerBackend starts with `desktop: true`.
// Calls ride the same backend connection as sync and exec, so a dropped
// transport reconnects the way every other Workspace call does.
//
// A backend whose computerd runs without a desktop answers every call
// with an `ENOSYS` error; this class does not hide that.

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
} from "@cloudflare/computer-rpc";

// "always" replays a call after a transport failure (reads, idempotent
// setup). "pre-dispatch" replays only when the failure proves nothing
// reached the daemon, which is what an input event needs: a click
// replayed twice is two clicks.
export type DesktopCallPolicy = "always" | "pre-dispatch";

export type DesktopDispatch = <T>(
  backend: string | undefined,
  operation: string,
  policy: DesktopCallPolicy,
  op: (desktop: DesktopRPC) => Promise<T>,
) => Promise<T>;

export class WorkspaceDesktop {
  readonly #dispatch: DesktopDispatch;
  readonly #backend: string | undefined;

  constructor(dispatch: DesktopDispatch, backend?: string) {
    this.#dispatch = dispatch;
    this.#backend = backend;
  }

  // The same surface bound to another backend id. The default is the
  // Workspace's first backend.
  backend(id: string): WorkspaceDesktop {
    return new WorkspaceDesktop(this.#dispatch, id);
  }

  #call<T>(
    operation: string,
    policy: DesktopCallPolicy,
    op: (desktop: DesktopRPC) => Promise<T>,
  ): Promise<T> {
    return this.#dispatch(this.#backend, `desktop.${operation}`, policy, op);
  }

  status(): Promise<DesktopStatus> {
    return this.#call("status", "always", (d) => d.status());
  }
  start(options?: DesktopStartOptions): Promise<DesktopStatus> {
    return this.#call("start", "always", (d) => d.start(options));
  }
  stop(): Promise<DesktopStatus> {
    return this.#call("stop", "always", (d) => d.stop());
  }
  screenshot(options?: DesktopScreenshotOptions): Promise<DesktopScreenshotResult> {
    return this.#call("screenshot", "always", (d) => d.screenshot(options));
  }
  click(input: DesktopClickInput = {}): Promise<void> {
    return this.#call("click", "pre-dispatch", (d) => d.click(input));
  }
  doubleClick(input: { x?: number; y?: number; button?: DesktopMouseButton } = {}): Promise<void> {
    return this.#call("doubleClick", "pre-dispatch", (d) => d.doubleClick(input));
  }
  tripleClick(input: { x?: number; y?: number; button?: DesktopMouseButton } = {}): Promise<void> {
    return this.#call("tripleClick", "pre-dispatch", (d) => d.tripleClick(input));
  }
  rightClick(input: { x?: number; y?: number } = {}): Promise<void> {
    return this.#call("rightClick", "pre-dispatch", (d) => d.rightClick(input));
  }
  middleClick(input: { x?: number; y?: number } = {}): Promise<void> {
    return this.#call("middleClick", "pre-dispatch", (d) => d.middleClick(input));
  }
  mouseDown(input?: DesktopMouseButtonInput): Promise<void> {
    return this.#call("mouseDown", "pre-dispatch", (d) => d.mouseDown(input));
  }
  mouseUp(input?: DesktopMouseButtonInput): Promise<void> {
    return this.#call("mouseUp", "pre-dispatch", (d) => d.mouseUp(input));
  }
  move(input: DesktopMoveInput): Promise<void> {
    return this.#call("move", "always", (d) => d.move(input));
  }
  drag(input: DesktopDragInput): Promise<void> {
    return this.#call("drag", "pre-dispatch", (d) => d.drag(input));
  }
  scroll(input: DesktopScrollInput): Promise<void> {
    return this.#call("scroll", "pre-dispatch", (d) => d.scroll(input));
  }
  type(input: DesktopTypeInput | string): Promise<void> {
    const body = typeof input === "string" ? { text: input } : input;
    return this.#call("type", "pre-dispatch", (d) => d.type(body));
  }
  key(input: DesktopKeyInput | string): Promise<void> {
    const body = typeof input === "string" ? { key: input } : input;
    return this.#call("key", "pre-dispatch", (d) => d.key(body));
  }
  cursorPosition(): Promise<DesktopPoint> {
    return this.#call("cursorPosition", "always", (d) => d.cursorPosition());
  }
  screenSize(): Promise<DesktopScreenSize> {
    return this.#call("screenSize", "always", (d) => d.screenSize());
  }
  windows(): Promise<DesktopWindowInfo[]> {
    return this.#call("windows", "always", (d) => d.windows());
  }
  focusWindow(input: { id?: string; title?: string }): Promise<void> {
    return this.#call("focusWindow", "always", (d) => d.focusWindow(input));
  }
  clipboardRead(): Promise<string> {
    return this.#call("clipboardRead", "always", (d) => d.clipboardRead());
  }
  clipboardWrite(text: string | { text: string }): Promise<void> {
    const body = typeof text === "string" ? { text } : text;
    return this.#call("clipboardWrite", "always", (d) => d.clipboardWrite(body));
  }
  wait(input: number | { durationMs: number }): Promise<void> {
    const body = typeof input === "number" ? { durationMs: input } : input;
    return this.#call("wait", "always", (d) => d.wait(body));
  }
}
