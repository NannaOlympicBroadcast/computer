import { type ChildProcess, spawn } from "node:child_process";

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

export interface CommandResult {
  stdout: Uint8Array;
  stderr: string;
  exitCode: number;
}

export type DesktopCommandRunner = (
  command: string,
  args: readonly string[],
  options?: {
    env?: Record<string, string>;
    stdin?: Uint8Array | string;
    timeoutMs?: number;
  },
) => Promise<CommandResult>;

export interface ManagedProcess {
  readonly pid?: number;
  kill(signal?: NodeJS.Signals): void;
  readonly exited: Promise<number | null>;
}

export type DesktopProcessSpawner = (
  command: string,
  args: readonly string[],
  options?: { env?: Record<string, string> },
) => ManagedProcess;

export interface DesktopControllerOptions {
  enabled?: boolean;
  display?: string;
  width?: number;
  height?: number;
  depth?: number;
  vncPort?: number | null;
  noVncPort?: number | null;
  noVncWebDir?: string;
  windowManager?: string | null;
  startDaemonProcesses?: boolean;
  runCommand?: DesktopCommandRunner;
  spawnProcess?: DesktopProcessSpawner;
}

const DEFAULT_DISPLAY = ":99";
const DEFAULT_WIDTH = 1280;
const DEFAULT_HEIGHT = 720;
const DEFAULT_DEPTH = 24;
const DEFAULT_VNC_PORT = 5900;
const DEFAULT_NOVNC_PORT = 6080;
const DEFAULT_NOVNC_WEB_DIR = "/usr/share/novnc";
const DEFAULT_WM = "fluxbox";

export function parseResolution(
  spec: string | undefined,
): { width: number; height: number; depth: number } | undefined {
  if (!spec) return undefined;
  const match = /^(\d+)x(\d+)(?:x(\d+))?$/i.exec(spec.trim());
  if (!match) {
    throw new Error(
      `Invalid desktop resolution ${JSON.stringify(spec)}; expected WIDTHxHEIGHT or WIDTHxHEIGHTxDEPTH (e.g. 1280x720x24)`,
    );
  }
  const width = Number.parseInt(match[1], 10);
  const height = Number.parseInt(match[2], 10);
  const depth = match[3] ? Number.parseInt(match[3], 10) : DEFAULT_DEPTH;
  if (width < 64 || height < 64 || (depth !== 16 && depth !== 24 && depth !== 32)) {
    throw new Error(`Unsupported desktop resolution dimensions: ${spec}`);
  }
  return { width, height, depth };
}

export function parseDesktopEnv(
  env: Record<string, string | undefined>,
  flags: Record<string, string | undefined> = {},
): DesktopControllerOptions {
  const rawEnabled = flags.desktop ?? env.DESKTOP_ENABLED;
  const enabled =
    rawEnabled === "1" ||
    rawEnabled === "true" ||
    rawEnabled === "yes" ||
    flags["desktop-display"] !== undefined ||
    flags["desktop-resolution"] !== undefined;

  const display = flags["desktop-display"] ?? env.DESKTOP_DISPLAY ?? env.DISPLAY ?? DEFAULT_DISPLAY;
  const res = parseResolution(flags["desktop-resolution"] ?? env.DESKTOP_RESOLUTION);

  const parseOptionalPort = (raw: string | undefined, fallback: number | null): number | null => {
    if (raw === undefined || raw.trim() === "") return fallback;
    if (raw === "0" || raw.toLowerCase() === "none" || raw.toLowerCase() === "false") return null;
    const port = Number.parseInt(raw, 10);
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
      throw new Error(`Invalid desktop port: ${raw}`);
    }
    return port;
  };

  const vncPort = parseOptionalPort(
    flags["vnc-port"] ?? env.VNC_PORT,
    enabled ? DEFAULT_VNC_PORT : null,
  );
  const noVncPort = parseOptionalPort(
    flags["novnc-port"] ?? env.NOVNC_PORT,
    enabled ? DEFAULT_NOVNC_PORT : null,
  );
  const wmRaw = flags["desktop-wm"] ?? env.DESKTOP_WM;
  const windowManager =
    wmRaw === "none" || wmRaw === "false" ? null : (wmRaw ?? (enabled ? DEFAULT_WM : null));

  return {
    enabled,
    display,
    width: res?.width ?? DEFAULT_WIDTH,
    height: res?.height ?? DEFAULT_HEIGHT,
    depth: res?.depth ?? DEFAULT_DEPTH,
    vncPort,
    noVncPort,
    noVncWebDir: env.NOVNC_WEB_DIR ?? DEFAULT_NOVNC_WEB_DIR,
    windowManager,
    startDaemonProcesses: env.DESKTOP_EXTERNAL_SERVER !== "1",
  };
}

export class DesktopController implements DesktopRPC {
  #enabled: boolean;
  #running = false;
  #display: string;
  #width: number;
  #height: number;
  #depth: number;
  #vncPort: number | null;
  #noVncPort: number | null;
  readonly #noVncWebDir: string;
  #windowManager: string | null;
  readonly #startDaemons: boolean;
  readonly #runCommand: DesktopCommandRunner;
  readonly #spawnProcess: DesktopProcessSpawner;
  readonly #daemons: ManagedProcess[] = [];
  #clipboardFallback = "";

  constructor(options: DesktopControllerOptions = {}) {
    this.#enabled = options.enabled ?? false;
    this.#display = options.display ?? DEFAULT_DISPLAY;
    this.#width = options.width ?? DEFAULT_WIDTH;
    this.#height = options.height ?? DEFAULT_HEIGHT;
    this.#depth = options.depth ?? DEFAULT_DEPTH;
    this.#vncPort =
      options.vncPort !== undefined ? options.vncPort : this.#enabled ? DEFAULT_VNC_PORT : null;
    this.#noVncPort =
      options.noVncPort !== undefined
        ? options.noVncPort
        : this.#enabled
          ? DEFAULT_NOVNC_PORT
          : null;
    this.#noVncWebDir = options.noVncWebDir ?? DEFAULT_NOVNC_WEB_DIR;
    this.#windowManager =
      options.windowManager !== undefined
        ? options.windowManager
        : this.#enabled
          ? DEFAULT_WM
          : null;
    this.#startDaemons = options.startDaemonProcesses ?? true;
    this.#runCommand = options.runCommand ?? defaultRunCommand;
    this.#spawnProcess = options.spawnProcess ?? defaultSpawnProcess;
  }

  get display(): string {
    return this.#display;
  }

  get enabled(): boolean {
    return this.#enabled;
  }

  getStatusSync(): DesktopStatus {
    return {
      enabled: this.#enabled,
      running: this.#running,
      display: this.#display,
      width: this.#width,
      height: this.#height,
      depth: this.#depth,
      vncPort: this.#vncPort,
      noVncPort: this.#noVncPort,
      windowManager: this.#windowManager,
    };
  }

  async status(): Promise<DesktopStatus> {
    return this.getStatusSync();
  }

  async start(options?: DesktopStartOptions): Promise<DesktopStatus> {
    if (options?.display !== undefined) this.#display = options.display;
    if (options?.width !== undefined) {
      assertPositiveInt(options.width, "width");
      this.#width = options.width;
    }
    if (options?.height !== undefined) {
      assertPositiveInt(options.height, "height");
      this.#height = options.height;
    }
    if (options?.depth !== undefined) {
      this.#depth = options.depth;
    }
    this.#enabled = true;
    if (this.#running) return this.getStatusSync();

    if (this.#startDaemons) {
      // Check if an X server is already accepting connections on this display.
      const probe = await this.#exec("xdpyinfo", ["-display", this.#display], {
        allowFailure: true,
        timeoutMs: 2_000,
      });
      if (probe.exitCode !== 0) {
        const xvfb = this.#spawnProcess("Xvfb", [
          this.#display,
          "-screen",
          "0",
          `${this.#width}x${this.#height}x${this.#depth}`,
          "-ac",
          "+extension",
          "GLX",
          "+render",
          "-noreset",
        ]);
        this.#daemons.push(xvfb);
        await this.#waitForDisplay(5_000);
      }

      if (this.#windowManager !== null) {
        const wm = this.#spawnProcess(this.#windowManager, [], {
          env: { DISPLAY: this.#display },
        });
        this.#daemons.push(wm);
      }

      if (this.#vncPort !== null) {
        const vnc = this.#spawnProcess(
          "x11vnc",
          [
            "-display",
            this.#display,
            "-forever",
            "-shared",
            "-nopw",
            "-rfbport",
            String(this.#vncPort),
            "-quiet",
          ],
          { env: { DISPLAY: this.#display } },
        );
        this.#daemons.push(vnc);
      }

      if (this.#noVncPort !== null && this.#vncPort !== null) {
        const novnc = this.#spawnProcess(
          "websockify",
          [`--web=${this.#noVncWebDir}`, String(this.#noVncPort), `127.0.0.1:${this.#vncPort}`],
          { env: { DISPLAY: this.#display } },
        );
        this.#daemons.push(novnc);
      }
    }

    this.#running = true;
    return this.getStatusSync();
  }

  async stop(): Promise<DesktopStatus> {
    while (this.#daemons.length > 0) {
      const daemon = this.#daemons.pop();
      if (!daemon) break;
      try {
        daemon.kill("SIGTERM");
      } catch {
        // already exited
      }
    }
    this.#running = false;
    return this.getStatusSync();
  }

  async screenshot(options?: DesktopScreenshotOptions): Promise<DesktopScreenshotResult> {
    await this.#ensureRunning();
    const format = options?.format ?? "png";
    if (format !== "png" && format !== "jpeg") {
      throw new Error(`Unsupported screenshot format: ${String(format)}`);
    }
    const display = options?.display ?? this.#display;
    const region = options?.region;
    if (region !== undefined) {
      assertNonNegativeInt(region.x, "region.x");
      assertNonNegativeInt(region.y, "region.y");
      assertPositiveInt(region.width, "region.width");
      assertPositiveInt(region.height, "region.height");
    }

    const mimeType = format === "jpeg" ? "image/jpeg" : "image/png";
    const qualityArgs =
      options?.quality !== undefined
        ? ["-quality", String(Math.max(1, Math.min(100, Math.round(options.quality))))]
        : [];
    const cropArgs =
      region !== undefined
        ? ["-crop", `${region.width}x${region.height}+${region.x}+${region.y}`, "+repage"]
        : [];

    // Try ImageMagick `import` writing directly to stdout first (no temp file needed).
    const importRes = await this.#exec(
      "import",
      ["-display", display, "-window", "root", ...cropArgs, ...qualityArgs, `${format}:-`],
      { display, allowFailure: true },
    );
    if (importRes.exitCode === 0 && importRes.stdout.byteLength > 0) {
      const dims = parseImageDimensions(
        importRes.stdout,
        region?.width ?? this.#width,
        region?.height ?? this.#height,
      );
      return { data: importRes.stdout, mimeType, width: dims.width, height: dims.height };
    }

    // Fallback 2: `scrot` writing to stdout via `/dev/stdout` or temp file.
    const scrotArgs = [
      ...(region !== undefined
        ? ["-a", `${region.x},${region.y},${region.width},${region.height}`]
        : []),
      ...(options?.quality !== undefined ? ["-q", String(Math.round(options.quality))] : []),
      "-o",
      `/dev/stdout`,
    ];
    const scrotRes = await this.#exec("scrot", scrotArgs, { display, allowFailure: true });
    if (scrotRes.exitCode === 0 && scrotRes.stdout.byteLength > 0) {
      const dims = parseImageDimensions(
        scrotRes.stdout,
        region?.width ?? this.#width,
        region?.height ?? this.#height,
      );
      return { data: scrotRes.stdout, mimeType, width: dims.width, height: dims.height };
    }

    // Fallback 3: `ffmpeg` x11grab single frame to stdout.
    const w = region?.width ?? this.#width;
    const h = region?.height ?? this.#height;
    const grabOffset = region !== undefined ? `+${region.x},${region.y}` : "";
    const ffmpegRes = await this.#exec(
      "ffmpeg",
      [
        "-loglevel",
        "error",
        "-f",
        "x11grab",
        "-video_size",
        `${w}x${h}`,
        "-i",
        `${display}${grabOffset}`,
        "-frames:v",
        "1",
        "-f",
        "image2pipe",
        "-vcodec",
        format === "jpeg" ? "mjpeg" : "png",
        "-",
      ],
      { display, allowFailure: true },
    );
    if (ffmpegRes.exitCode === 0 && ffmpegRes.stdout.byteLength > 0) {
      const dims = parseImageDimensions(ffmpegRes.stdout, w, h);
      return { data: ffmpegRes.stdout, mimeType, width: dims.width, height: dims.height };
    }

    throw new Error(
      `Desktop screenshot failed on display ${display}: ${
        importRes.stderr.trim() ||
        scrotRes.stderr.trim() ||
        ffmpegRes.stderr.trim() ||
        "no screenshot utility (import, scrot, or ffmpeg) succeeded"
      }`,
    );
  }

  async click(input: DesktopClickInput): Promise<void> {
    await this.#ensureRunning();
    const button = resolveMouseButton(input.button ?? "left");
    const count = input.count ?? 1;
    assertPositiveInt(count, "count");
    const args: string[] = [];
    if (input.x !== undefined || input.y !== undefined) {
      if (input.x === undefined || input.y === undefined) {
        throw new Error("Both x and y must be provided when positioning a click.");
      }
      assertFiniteCoord(input.x, "x");
      assertFiniteCoord(input.y, "y");
      args.push("mousemove", "--", String(Math.round(input.x)), String(Math.round(input.y)));
    }
    const modifiers = (input.modifiers ?? []).map(normalizeKeySpec);
    for (const mod of modifiers) {
      args.push("keydown", mod);
    }
    if (count > 1) {
      args.push("click", "--repeat", String(count), "--delay", "50", String(button));
    } else {
      args.push("click", String(button));
    }
    for (const mod of [...modifiers].reverse()) {
      args.push("keyup", mod);
    }
    await this.#exec("xdotool", args);
  }

  async doubleClick(input: { x?: number; y?: number; button?: DesktopMouseButton }): Promise<void> {
    await this.click({ ...input, count: 2 });
  }

  async tripleClick(input: { x?: number; y?: number; button?: DesktopMouseButton }): Promise<void> {
    await this.click({ ...input, count: 3 });
  }

  async rightClick(input: { x?: number; y?: number }): Promise<void> {
    await this.click({ ...input, button: "right", count: 1 });
  }

  async middleClick(input: { x?: number; y?: number }): Promise<void> {
    await this.click({ ...input, button: "middle", count: 1 });
  }

  async mouseDown(input: DesktopMouseButtonInput = {}): Promise<void> {
    await this.#ensureRunning();
    const button = resolveMouseButton(input.button ?? "left");
    const args: string[] = [];
    if (input.x !== undefined || input.y !== undefined) {
      if (input.x === undefined || input.y === undefined) {
        throw new Error("Both x and y must be provided when positioning mouseDown.");
      }
      assertFiniteCoord(input.x, "x");
      assertFiniteCoord(input.y, "y");
      args.push("mousemove", "--", String(Math.round(input.x)), String(Math.round(input.y)));
    }
    args.push("mousedown", String(button));
    await this.#exec("xdotool", args);
  }

  async mouseUp(input: DesktopMouseButtonInput = {}): Promise<void> {
    await this.#ensureRunning();
    const button = resolveMouseButton(input.button ?? "left");
    const args: string[] = [];
    if (input.x !== undefined || input.y !== undefined) {
      if (input.x === undefined || input.y === undefined) {
        throw new Error("Both x and y must be provided when positioning mouseUp.");
      }
      assertFiniteCoord(input.x, "x");
      assertFiniteCoord(input.y, "y");
      args.push("mousemove", "--", String(Math.round(input.x)), String(Math.round(input.y)));
    }
    args.push("mouseup", String(button));
    await this.#exec("xdotool", args);
  }

  async move(input: DesktopMoveInput): Promise<void> {
    await this.#ensureRunning();
    assertFiniteCoord(input.x, "x");
    assertFiniteCoord(input.y, "y");
    const args = input.relative
      ? ["mousemove_relative", "--", String(Math.round(input.x)), String(Math.round(input.y))]
      : ["mousemove", "--", String(Math.round(input.x)), String(Math.round(input.y))];
    await this.#exec("xdotool", args);
  }

  async drag(input: DesktopDragInput): Promise<void> {
    await this.#ensureRunning();
    assertFiniteCoord(input.startX, "startX");
    assertFiniteCoord(input.startY, "startY");
    assertFiniteCoord(input.endX, "endX");
    assertFiniteCoord(input.endY, "endY");
    const button = resolveMouseButton(input.button ?? "left");
    const steps = Math.max(
      1,
      Math.min(100, Math.round(input.steps ?? (input.durationMs ? 10 : 1))),
    );
    const stepDelayMs =
      input.durationMs !== undefined && steps > 1
        ? Math.max(0, Math.round(input.durationMs / steps))
        : 0;

    await this.#exec("xdotool", [
      "mousemove",
      "--",
      String(Math.round(input.startX)),
      String(Math.round(input.startY)),
      "mousedown",
      String(button),
    ]);

    for (let i = 1; i <= steps; i++) {
      if (stepDelayMs > 0) {
        await sleep(stepDelayMs);
      }
      const x = Math.round(input.startX + ((input.endX - input.startX) * i) / steps);
      const y = Math.round(input.startY + ((input.endY - input.startY) * i) / steps);
      await this.#exec("xdotool", ["mousemove", "--", String(x), String(y)]);
    }

    await this.#exec("xdotool", ["mouseup", String(button)]);
  }

  async scroll(input: DesktopScrollInput): Promise<void> {
    await this.#ensureRunning();
    const args: string[] = [];
    if (input.x !== undefined || input.y !== undefined) {
      if (input.x === undefined || input.y === undefined) {
        throw new Error("Both x and y must be provided when positioning scroll.");
      }
      assertFiniteCoord(input.x, "x");
      assertFiniteCoord(input.y, "y");
      args.push("mousemove", "--", String(Math.round(input.x)), String(Math.round(input.y)));
    }

    let direction = input.direction;
    let amount = input.amount;
    if (direction === undefined) {
      if (input.deltaY !== undefined && input.deltaY !== 0) {
        direction = input.deltaY > 0 ? "down" : "up";
        amount ??= Math.max(1, Math.round(Math.abs(input.deltaY)));
      } else if (input.deltaX !== undefined && input.deltaX !== 0) {
        direction = input.deltaX > 0 ? "right" : "left";
        amount ??= Math.max(1, Math.round(Math.abs(input.deltaX)));
      } else {
        direction = "down";
      }
    }
    const ticks = Math.max(1, Math.min(100, Math.round(amount ?? 3)));
    const wheelButton =
      direction === "up" ? 4 : direction === "down" ? 5 : direction === "left" ? 6 : 7;
    args.push("click", "--repeat", String(ticks), String(wheelButton));
    await this.#exec("xdotool", args);
  }

  async type(input: DesktopTypeInput): Promise<void> {
    await this.#ensureRunning();
    if (typeof input.text !== "string") {
      throw new Error("type requires a string `text`.");
    }
    if (input.text.length === 0) return;
    const delayMs = input.delayMs !== undefined ? Math.max(0, Math.round(input.delayMs)) : 12;
    await this.#exec("xdotool", [
      "type",
      "--clearmodifiers",
      "--delay",
      String(delayMs),
      "--",
      input.text,
    ]);
  }

  async key(input: DesktopKeyInput): Promise<void> {
    await this.#ensureRunning();
    if (typeof input.key !== "string" || input.key.trim() === "") {
      throw new Error("key requires a non-empty key specification.");
    }
    const action = input.action ?? "press";
    const subcommand = action === "down" ? "keydown" : action === "up" ? "keyup" : "key";
    const normalized = normalizeKeySpec(input.key);
    await this.#exec("xdotool", [subcommand, "--clearmodifiers", "--", normalized]);
  }

  async cursorPosition(): Promise<DesktopPoint> {
    await this.#ensureRunning();
    const res = await this.#exec("xdotool", ["getmouselocation", "--shell"]);
    const text = new TextDecoder().decode(res.stdout);
    const xMatch = /^X=(-?\d+)$/m.exec(text);
    const yMatch = /^Y=(-?\d+)$/m.exec(text);
    const screenMatch = /^SCREEN=(\d+)$/m.exec(text);
    if (!xMatch || !yMatch) {
      throw new Error(`Failed to parse xdotool getmouselocation output: ${JSON.stringify(text)}`);
    }
    return {
      x: Number.parseInt(xMatch[1], 10),
      y: Number.parseInt(yMatch[1], 10),
      ...(screenMatch ? { screen: Number.parseInt(screenMatch[1], 10) } : {}),
    };
  }

  async screenSize(): Promise<DesktopScreenSize> {
    await this.#ensureRunning();
    const res = await this.#exec("xdotool", ["getdisplaygeometry"], { allowFailure: true });
    if (res.exitCode === 0) {
      const text = new TextDecoder().decode(res.stdout).trim();
      const match = /^(\d+)\s+(\d+)$/.exec(text);
      if (match) {
        return {
          width: Number.parseInt(match[1], 10),
          height: Number.parseInt(match[2], 10),
          display: this.#display,
        };
      }
    }
    return {
      width: this.#width,
      height: this.#height,
      display: this.#display,
    };
  }

  async windows(): Promise<DesktopWindowInfo[]> {
    await this.#ensureRunning();
    const wmctrlRes = await this.#exec("wmctrl", ["-l", "-G", "-p"], { allowFailure: true });
    if (wmctrlRes.exitCode === 0) {
      const text = new TextDecoder().decode(wmctrlRes.stdout);
      const list: DesktopWindowInfo[] = [];
      for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line) continue;
        // Format: <win_id> <desktop> <pid> <x> <y> <w> <h> <host> <title...>
        const match =
          /^(0x[0-9a-fA-F]+|\d+)\s+(-?\d+)\s+(\d+)\s+(-?\d+)\s+(-?\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/.exec(
            line,
          );
        if (match) {
          list.push({
            id: match[1],
            pid: Number.parseInt(match[3], 10),
            x: Number.parseInt(match[4], 10),
            y: Number.parseInt(match[5], 10),
            width: Number.parseInt(match[6], 10),
            height: Number.parseInt(match[7], 10),
            title: match[9] ?? "",
          });
        }
      }
      return list;
    }

    const searchRes = await this.#exec("xdotool", ["search", "--onlyvisible", "--name", ""], {
      allowFailure: true,
    });
    if (searchRes.exitCode !== 0) return [];
    const ids = new TextDecoder()
      .decode(searchRes.stdout)
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    const windows: DesktopWindowInfo[] = [];
    for (const id of ids) {
      const nameRes = await this.#exec("xdotool", ["getwindowname", id], { allowFailure: true });
      const title = nameRes.exitCode === 0 ? new TextDecoder().decode(nameRes.stdout).trim() : "";
      windows.push({ id, title });
    }
    return windows;
  }

  async focusWindow(input: { id?: string; title?: string }): Promise<void> {
    await this.#ensureRunning();
    if (input.id !== undefined && input.id.trim() !== "") {
      await this.#exec("xdotool", ["windowactivate", input.id.trim()]);
      return;
    }
    if (input.title !== undefined && input.title.trim() !== "") {
      const wmctrl = await this.#exec("wmctrl", ["-a", input.title], { allowFailure: true });
      if (wmctrl.exitCode === 0) return;
      await this.#exec("xdotool", [
        "search",
        "--onlyvisible",
        "--name",
        input.title,
        "windowactivate",
      ]);
      return;
    }
    throw new Error("focusWindow requires either `id` or `title`.");
  }

  async clipboardRead(): Promise<string> {
    await this.#ensureRunning();
    const xclip = await this.#exec("xclip", ["-o", "-selection", "clipboard"], {
      allowFailure: true,
    });
    if (xclip.exitCode === 0) {
      return new TextDecoder().decode(xclip.stdout);
    }
    const xsel = await this.#exec("xsel", ["-ob"], { allowFailure: true });
    if (xsel.exitCode === 0) {
      return new TextDecoder().decode(xsel.stdout);
    }
    return this.#clipboardFallback;
  }

  async clipboardWrite(input: { text: string }): Promise<void> {
    await this.#ensureRunning();
    this.#clipboardFallback = input.text;
    const xclip = await this.#exec("xclip", ["-i", "-selection", "clipboard"], {
      stdin: input.text,
      allowFailure: true,
    });
    if (xclip.exitCode === 0) return;
    const xsel = await this.#exec("xsel", ["-ib"], {
      stdin: input.text,
      allowFailure: true,
    });
    if (xsel.exitCode === 0) return;
  }

  async wait(input: { durationMs: number }): Promise<void> {
    const ms = Math.max(0, Math.min(Number(input.durationMs) || 0, 60_000));
    await sleep(ms);
  }

  async #ensureRunning(): Promise<void> {
    if (this.#running) return;
    if (!this.#enabled) {
      const err = new Error(
        "Desktop environment is not enabled on this computerd instance. Start computerd with DESKTOP_ENABLED=1 or call desktop.start() first.",
      ) as Error & { code: string };
      err.code = "ENOSYS";
      throw err;
    }
    await this.start();
  }

  async #waitForDisplay(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const res = await this.#exec("xdpyinfo", ["-display", this.#display], {
        allowFailure: true,
        timeoutMs: 1_000,
      });
      if (res.exitCode === 0) return;
      await sleep(100);
    }
    throw new Error(`Timed out waiting for X server on display ${this.#display}`);
  }

  async #exec(
    command: string,
    args: readonly string[],
    options?: {
      display?: string;
      stdin?: Uint8Array | string;
      allowFailure?: boolean;
      timeoutMs?: number;
    },
  ): Promise<CommandResult> {
    const display = options?.display ?? this.#display;
    const res = await this.#runCommand(command, args, {
      env: { DISPLAY: display },
      stdin: options?.stdin,
      timeoutMs: options?.timeoutMs ?? 15_000,
    });
    if (res.exitCode !== 0 && options?.allowFailure !== true) {
      throw new Error(
        `Desktop command "${command} ${args.join(" ")}" failed with exit code ${res.exitCode}: ${res.stderr.trim() || "no stderr"}`,
      );
    }
    return res;
  }
}

function resolveMouseButton(button: DesktopMouseButton): number {
  switch (button) {
    case "left":
    case 1:
      return 1;
    case "middle":
    case 2:
      return 2;
    case "right":
    case 3:
      return 3;
    case 4:
    case "back":
      return 8;
    case 5:
    case "forward":
      return 9;
    default:
      throw new Error(`Unsupported mouse button: ${String(button)}`);
  }
}

const KEY_ALIASES: Readonly<Record<string, string>> = {
  enter: "Return",
  return: "Return",
  esc: "Escape",
  escape: "Escape",
  backspace: "BackSpace",
  tab: "Tab",
  space: "space",
  " ": "space",
  delete: "Delete",
  del: "Delete",
  insert: "Insert",
  home: "Home",
  end: "End",
  pageup: "Prior",
  pgup: "Prior",
  pagedown: "Next",
  pgdn: "Next",
  up: "Up",
  arrowup: "Up",
  down: "Down",
  arrowdown: "Down",
  left: "Left",
  arrowleft: "Left",
  right: "Right",
  arrowright: "Right",
  ctrl: "ctrl",
  control: "ctrl",
  alt: "alt",
  option: "alt",
  shift: "shift",
  meta: "super",
  cmd: "super",
  command: "super",
  win: "super",
  super: "super",
};

export function normalizeKeySpec(spec: string): string {
  const trimmed = spec.trim();
  if (trimmed.includes("+")) {
    return trimmed
      .split("+")
      .map((part) => {
        const p = part.trim();
        return KEY_ALIASES[p.toLowerCase()] ?? p;
      })
      .join("+");
  }
  return KEY_ALIASES[trimmed.toLowerCase()] ?? trimmed;
}

export function parseImageDimensions(
  bytes: Uint8Array,
  fallbackWidth: number,
  fallbackHeight: number,
): { width: number; height: number } {
  // PNG: 8-byte signature + 4-byte length + "IHDR" + 4-byte width + 4-byte height
  if (
    bytes.byteLength >= 24 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const width = view.getUint32(16, false);
    const height = view.getUint32(20, false);
    if (width > 0 && height > 0) return { width, height };
  }
  // JPEG: scan SOF0/SOF2 markers (0xFF 0xC0 / 0xFF 0xC2)
  if (bytes.byteLength >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    while (offset + 9 < bytes.byteLength) {
      if (bytes[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = bytes[offset + 1];
      if (marker === 0xff) {
        offset += 1;
        continue;
      }
      if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
        const height = view.getUint16(offset + 5, false);
        const width = view.getUint16(offset + 7, false);
        if (width > 0 && height > 0) return { width, height };
        break;
      }
      if (marker === 0xd9 || marker === 0xda) break;
      const segLen = view.getUint16(offset + 2, false);
      if (segLen < 2) break;
      offset += 2 + segLen;
    }
  }
  return { width: fallbackWidth, height: fallbackHeight };
}

function assertPositiveInt(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer; got ${String(value)}`);
  }
}

function assertNonNegativeInt(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer; got ${String(value)}`);
  }
}

function assertFiniteCoord(value: number, name: string): void {
  if (!Number.isFinite(value)) {
    throw new Error(`${name} must be a finite number; got ${String(value)}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function defaultRunCommand(
  command: string,
  args: readonly string[],
  options?: {
    env?: Record<string, string>;
    stdin?: Uint8Array | string;
    timeoutMs?: number;
  },
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(command, [...args], {
      env: { ...process.env, ...options?.env },
      stdio: [options?.stdin !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let timer: NodeJS.Timeout | undefined;
    if (options?.timeoutMs && options.timeoutMs > 0) {
      timer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // ignore
        }
      }, options.timeoutMs);
    }
    child.stdout?.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
    if (options?.stdin !== undefined && child.stdin) {
      child.stdin.on("error", () => {});
      child.stdin.end(
        typeof options.stdin === "string"
          ? Buffer.from(options.stdin, "utf8")
          : Buffer.from(options.stdin),
      );
    }
    let settled = false;
    const finish = (code: number | null, errMessage?: string) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      resolve({
        stdout: new Uint8Array(Buffer.concat(stdoutChunks)),
        stderr: errMessage ?? Buffer.concat(stderrChunks).toString("utf8"),
        exitCode: code ?? 1,
      });
    };
    child.once("error", (err) => {
      finish(127, err.message);
    });
    child.once("exit", (code) => {
      // Tools like `xclip -i` fork a background X11 selection owner that
      // inherits stdout/stderr; settle shortly after the parent exits if
      // stdio stays open.
      setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish(code);
      }, 20);
    });
    child.once("close", (code) => {
      finish(code);
    });
  });
}

function defaultSpawnProcess(
  command: string,
  args: readonly string[],
  options?: { env?: Record<string, string> },
): ManagedProcess {
  let child: ChildProcess | undefined;
  let exitedResolve!: (code: number | null) => void;
  const exited = new Promise<number | null>((resolve) => {
    exitedResolve = resolve;
  });
  try {
    child = spawn(command, [...args], {
      env: { ...process.env, ...options?.env },
      stdio: "ignore",
    });
    child.once("error", () => exitedResolve(null));
    child.once("exit", (code) => exitedResolve(code));
  } catch {
    exitedResolve(null);
  }
  return {
    get pid() {
      return child?.pid;
    },
    kill(signal: NodeJS.Signals = "SIGTERM") {
      try {
        child?.kill(signal);
      } catch {
        // ignore
      }
    },
    exited,
  };
}
