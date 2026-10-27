import { describe, expect, it } from "vitest";

import {
  type CommandResult,
  DesktopController,
  normalizeKeySpec,
  parseDesktopEnv,
  parseImageDimensions,
  parseResolution,
} from "./controller.js";

// Minimal 1x1 PNG header (IHDR width=640, height=480)
function makeFakePng(width = 640, height = 480): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  bytes.set([0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52], 8);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width, false);
  view.setUint32(20, height, false);
  return bytes;
}

describe("DesktopController helpers", () => {
  it("parses resolution strings", () => {
    expect(parseResolution("1920x1080x24")).toEqual({ width: 1920, height: 1080, depth: 24 });
    expect(parseResolution("1280x720")).toEqual({ width: 1280, height: 720, depth: 24 });
    expect(() => parseResolution("invalid")).toThrow(/Invalid desktop resolution/);
  });

  it("parses desktop environment variables", () => {
    const opts = parseDesktopEnv({
      DESKTOP_ENABLED: "1",
      DESKTOP_DISPLAY: ":42",
      DESKTOP_RESOLUTION: "1024x768x24",
      VNC_PORT: "5901",
      NOVNC_PORT: "6081",
      DESKTOP_WM: "openbox",
    });
    expect(opts).toMatchObject({
      enabled: true,
      display: ":42",
      width: 1024,
      height: 768,
      depth: 24,
      vncPort: 5901,
      noVncPort: 6081,
      windowManager: "openbox",
    });
  });

  it("normalizes key specifications for xdotool", () => {
    expect(normalizeKeySpec("Enter")).toBe("Return");
    expect(normalizeKeySpec("Esc")).toBe("Escape");
    expect(normalizeKeySpec("Ctrl+Shift+t")).toBe("ctrl+shift+t");
    expect(normalizeKeySpec("Cmd+c")).toBe("super+c");
    expect(normalizeKeySpec("ArrowDown")).toBe("Down");
    expect(normalizeKeySpec("PageDown")).toBe("Next");
  });

  it("extracts PNG dimensions from IHDR", () => {
    const png = makeFakePng(800, 600);
    expect(parseImageDimensions(png, 1280, 720)).toEqual({ width: 800, height: 600 });
  });
});

describe("DesktopController lifecycle and operations", () => {
  it("starts Xvfb, window manager, x11vnc, and websockify and stops them cleanly", async () => {
    const spawned: Array<{ cmd: string; args: readonly string[] }> = [];
    const killed: string[] = [];
    let displayReady = false;

    const controller = new DesktopController({
      enabled: true,
      display: ":99",
      width: 1280,
      height: 720,
      vncPort: 5900,
      noVncPort: 6080,
      windowManager: "fluxbox",
      spawnProcess(cmd, args) {
        spawned.push({ cmd, args });
        if (cmd === "Xvfb") displayReady = true;
        return {
          pid: 1000 + spawned.length,
          kill() {
            killed.push(cmd);
          },
          exited: Promise.resolve(0),
        };
      },
      async runCommand(cmd): Promise<CommandResult> {
        if (cmd === "xdpyinfo") {
          return {
            stdout: new Uint8Array(0),
            stderr: "",
            exitCode: displayReady ? 0 : 1,
          };
        }
        return { stdout: new Uint8Array(0), stderr: "", exitCode: 0 };
      },
    });

    const status = await controller.start();
    expect(status.running).toBe(true);
    expect(spawned.map((s) => s.cmd)).toEqual(["Xvfb", "fluxbox", "x11vnc", "websockify"]);

    const stopped = await controller.stop();
    expect(stopped.running).toBe(false);
    expect(killed).toEqual(["websockify", "x11vnc", "fluxbox", "Xvfb"]);
  });

  it("executes screenshot, mouse, keyboard, window, and clipboard operations", async () => {
    const commands: Array<{ cmd: string; args: readonly string[]; stdin?: string }> = [];
    let clipboard = "initial";

    const controller = new DesktopController({
      enabled: true,
      display: ":99",
      startDaemonProcesses: false,
      async runCommand(cmd, args, opts): Promise<CommandResult> {
        const stdinText =
          typeof opts?.stdin === "string"
            ? opts.stdin
            : opts?.stdin instanceof Uint8Array
              ? new TextDecoder().decode(opts.stdin)
              : undefined;
        commands.push({ cmd, args, ...(stdinText !== undefined ? { stdin: stdinText } : {}) });

        if (cmd === "import") {
          return {
            stdout: makeFakePng(1280, 720),
            stderr: "",
            exitCode: 0,
          };
        }
        if (cmd === "xdotool" && args[0] === "getmouselocation") {
          return {
            stdout: new TextEncoder().encode("X=450\nY=300\nSCREEN=0\nWINDOW=123\n"),
            stderr: "",
            exitCode: 0,
          };
        }
        if (cmd === "xdotool" && args[0] === "getdisplaygeometry") {
          return {
            stdout: new TextEncoder().encode("1280 720\n"),
            stderr: "",
            exitCode: 0,
          };
        }
        if (cmd === "wmctrl" && args[0] === "-l") {
          return {
            stdout: new TextEncoder().encode(
              "0x00400001  0 1234   10   20  800  600 host Terminal\n",
            ),
            stderr: "",
            exitCode: 0,
          };
        }
        if (cmd === "xclip" && args.includes("-i")) {
          clipboard = stdinText ?? "";
          return { stdout: new Uint8Array(0), stderr: "", exitCode: 0 };
        }
        if (cmd === "xclip" && args.includes("-o")) {
          return {
            stdout: new TextEncoder().encode(clipboard),
            stderr: "",
            exitCode: 0,
          };
        }
        return { stdout: new Uint8Array(0), stderr: "", exitCode: 0 };
      },
    });

    await controller.start();

    const shot = await controller.screenshot({
      format: "png",
      region: { x: 10, y: 20, width: 400, height: 300 },
    });
    expect(shot.mimeType).toBe("image/png");
    expect(shot.width).toBe(1280);
    expect(shot.height).toBe(720);

    await controller.click({ x: 100, y: 200, button: "left", modifiers: ["ctrl"] });
    await controller.doubleClick({ x: 150, y: 250 });
    await controller.rightClick({ x: 300, y: 400 });
    await controller.move({ x: 500, y: 600 });
    await controller.drag({ startX: 10, startY: 10, endX: 100, endY: 100, steps: 2 });
    await controller.scroll({ x: 200, y: 200, direction: "down", amount: 5 });
    await controller.type({ text: "hello", delayMs: 10 });
    await controller.key({ key: "Ctrl+c", action: "press" });

    expect(await controller.cursorPosition()).toEqual({ x: 450, y: 300, screen: 0 });
    expect(await controller.screenSize()).toEqual({ width: 1280, height: 720, display: ":99" });

    const wins = await controller.windows();
    expect(wins).toEqual([
      {
        id: "0x00400001",
        pid: 1234,
        x: 10,
        y: 20,
        width: 800,
        height: 600,
        title: "Terminal",
      },
    ]);

    await controller.focusWindow({ id: "0x00400001" });
    await controller.clipboardWrite({ text: "new clipboard text" });
    expect(await controller.clipboardRead()).toBe("new clipboard text");

    expect(commands.some((c) => c.cmd === "xdotool" && c.args.includes("keydown"))).toBe(true);
    expect(commands.some((c) => c.cmd === "xdotool" && c.args.includes("ctrl+c"))).toBe(true);
  });
});
