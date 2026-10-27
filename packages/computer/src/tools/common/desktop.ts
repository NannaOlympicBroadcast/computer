import { z } from "zod";
import type { ModelOutput } from "./model-output.js";

// Structural slice of `workspace.desktop`, so the tool depends on the
// shape rather than on the Workspace class and works against a
// WorkspaceClient too.
export interface DesktopLike {
  screenshot(options?: {
    format?: "png" | "jpeg";
    quality?: number;
    region?: { x: number; y: number; width: number; height: number };
  }): Promise<{ data: Uint8Array; mimeType: string; width: number; height: number }>;
  click(input?: { x?: number; y?: number; button?: never; count?: number }): Promise<void>;
  doubleClick(input?: { x?: number; y?: number }): Promise<void>;
  tripleClick(input?: { x?: number; y?: number }): Promise<void>;
  rightClick(input?: { x?: number; y?: number }): Promise<void>;
  middleClick(input?: { x?: number; y?: number }): Promise<void>;
  move(input: { x: number; y: number }): Promise<void>;
  drag(input: { startX: number; startY: number; endX: number; endY: number }): Promise<void>;
  scroll(input: {
    x?: number;
    y?: number;
    direction?: "up" | "down" | "left" | "right";
    amount?: number;
  }): Promise<void>;
  type(input: { text: string }): Promise<void>;
  key(input: { key: string }): Promise<void>;
  cursorPosition(): Promise<{ x: number; y: number }>;
  screenSize(): Promise<{ width: number; height: number }>;
  windows(): Promise<unknown[]>;
  focusWindow(input: { id?: string; title?: string }): Promise<void>;
  clipboardRead(): Promise<string>;
  clipboardWrite(input: { text: string }): Promise<void>;
  wait(input: { durationMs: number }): Promise<void>;
}

export interface DesktopWorkspaceLike {
  readonly desktop?: unknown;
}

export interface DesktopToolOptions {
  workspace: DesktopWorkspaceLike;
}

export const DESKTOP_ACTIONS = [
  "screenshot",
  "click",
  "double_click",
  "triple_click",
  "right_click",
  "middle_click",
  "move",
  "drag",
  "scroll",
  "type",
  "key",
  "cursor_position",
  "screen_size",
  "windows",
  "focus_window",
  "clipboard_read",
  "clipboard_write",
  "wait",
] as const;

export const desktopInputSchema = z.object({
  action: z.enum(DESKTOP_ACTIONS).describe("The desktop action to perform."),
  x: z.number().int().optional().describe("Screen X in pixels, for pointer actions."),
  y: z.number().int().optional().describe("Screen Y in pixels, for pointer actions."),
  endX: z.number().int().optional().describe("Drag end X in pixels. Drag starts at x, y."),
  endY: z.number().int().optional().describe("Drag end Y in pixels. Drag starts at x, y."),
  text: z
    .string()
    .optional()
    .describe("Text for type and clipboard_write; title for focus_window."),
  key: z
    .string()
    .optional()
    .describe('Key or chord for key, such as "Return", "ctrl+c", or "alt+Tab".'),
  direction: z.enum(["up", "down", "left", "right"]).optional().describe("Scroll direction."),
  amount: z.number().int().positive().optional().describe("Scroll clicks. Default 3."),
  windowId: z.string().optional().describe("Window id for focus_window, from windows."),
  durationMs: z.number().int().nonnegative().optional().describe("Milliseconds for wait."),
});

export type DesktopInput = z.infer<typeof desktopInputSchema>;

export type DesktopToolResult = { ok: true; [key: string]: unknown } | { ok: false; error: string };

export interface DesktopScreenshotOutput {
  ok: true;
  action: "screenshot";
  width: number;
  height: number;
  mimeType: string;
  /** Base64 image bytes. */
  data: string;
}

export const desktopDescription =
  "Operate the workspace's graphical desktop like a person: take a screenshot, move and click the mouse, drag, scroll, type text, press keys, read or write the clipboard, and list or focus windows. Take a screenshot first to see the screen, then act on pixel coordinates from it, and take another screenshot to confirm the result.";

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function need<T>(value: T | undefined, name: string, action: string): T {
  if (value === undefined) throw new Error(`${action} requires \`${name}\``);
  return value;
}

/**
 * Bind a desktop executor to one workspace. Resolved at construction,
 * so a workspace with no `desktop` fails when the tool is built rather
 * than on the model's first call.
 */
export function createDesktopExecutor(
  workspace: DesktopWorkspaceLike,
): (input: DesktopInput) => Promise<DesktopToolResult | DesktopScreenshotOutput> {
  const desktop = workspace.desktop as DesktopLike | undefined;
  if (!desktop) throw new Error("createDesktopTool: workspace.desktop is not available");

  return async (input) => {
    const at = { x: input.x, y: input.y };
    try {
      switch (input.action) {
        case "screenshot": {
          const shot = await desktop.screenshot({ format: "png" });
          return {
            ok: true,
            action: "screenshot",
            width: shot.width,
            height: shot.height,
            mimeType: shot.mimeType,
            data: toBase64(shot.data),
          };
        }
        case "click":
          await desktop.click(at);
          break;
        case "double_click":
          await desktop.doubleClick(at);
          break;
        case "triple_click":
          await desktop.tripleClick(at);
          break;
        case "right_click":
          await desktop.rightClick(at);
          break;
        case "middle_click":
          await desktop.middleClick(at);
          break;
        case "move":
          await desktop.move({ x: need(input.x, "x", "move"), y: need(input.y, "y", "move") });
          break;
        case "drag":
          await desktop.drag({
            startX: need(input.x, "x", "drag"),
            startY: need(input.y, "y", "drag"),
            endX: need(input.endX, "endX", "drag"),
            endY: need(input.endY, "endY", "drag"),
          });
          break;
        case "scroll":
          await desktop.scroll({
            ...at,
            direction: input.direction ?? "down",
            amount: input.amount ?? 3,
          });
          break;
        case "type":
          await desktop.type({ text: need(input.text, "text", "type") });
          break;
        case "key":
          await desktop.key({ key: need(input.key, "key", "key") });
          break;
        case "cursor_position":
          return { ok: true, ...(await desktop.cursorPosition()) };
        case "screen_size":
          return { ok: true, ...(await desktop.screenSize()) };
        case "windows":
          return { ok: true, windows: await desktop.windows() };
        case "focus_window":
          await desktop.focusWindow({ id: input.windowId, title: input.text });
          break;
        case "clipboard_read":
          return { ok: true, text: await desktop.clipboardRead() };
        case "clipboard_write":
          await desktop.clipboardWrite({ text: need(input.text, "text", "clipboard_write") });
          break;
        case "wait":
          await desktop.wait({ durationMs: input.durationMs ?? 1000 });
          break;
      }
      return { ok: true, action: input.action };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  };
}

/** Show a screenshot to the model as an image; everything else as JSON. */
export function desktopModelOutput(output: unknown): ModelOutput {
  const result = output as {
    ok?: boolean;
    error?: string;
    action?: string;
    data?: string;
    width?: number;
    height?: number;
    mimeType?: string;
  };
  if (result.ok === false) {
    return { type: "error-text", value: result.error ?? "desktop action failed" };
  }
  if (result.action === "screenshot" && typeof result.data === "string") {
    return {
      type: "media",
      text: `Screenshot ${result.width}x${result.height}.`,
      data: result.data,
      mediaType: result.mimeType ?? "image/png",
      filename: "screenshot.png",
    };
  }
  return { type: "json", value: output };
}
