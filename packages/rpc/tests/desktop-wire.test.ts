import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { Database, initializeSchema } from "@cloudflare/dofs";
import { SQLiteTestStorage } from "@cloudflare/dofs/testing";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket, { WebSocketServer } from "ws";

import { createWorkspaceClient } from "../src/client.js";
import type { DesktopRPC, DesktopStatus } from "../src/interface.js";
import { acceptWebSocketSession, createWorkspaceServer, type RunnerLike } from "../src/server.js";

const fakeRunner: RunnerLike = {
  exec(_cmd, opts) {
    const id = opts?.id ?? "exec-1";
    return {
      id,
      events: new ReadableStream({
        start(c) {
          c.enqueue({ id, seq: 1, name: "exit", code: 0 });
          c.close();
        },
      }),
    };
  },
  get(id) {
    return {
      id,
      events: new ReadableStream({
        start(c) {
          c.close();
        },
      }),
    };
  },
  kill() {},
  dispose() {},
};

function createFakeDesktop(): { desktop: DesktopRPC; log: string[] } {
  const log: string[] = [];
  let running = true;
  let clipboard = "initial";
  let cursor = { x: 100, y: 200 };
  const status = (): DesktopStatus => ({
    enabled: true,
    running,
    display: ":99",
    width: 1280,
    height: 720,
    depth: 24,
    vncPort: 5900,
    noVncPort: 6080,
    windowManager: "fluxbox",
  });
  return {
    log,
    desktop: {
      async status() {
        log.push("status");
        return status();
      },
      async start() {
        running = true;
        log.push("start");
        return status();
      },
      async stop() {
        running = false;
        log.push("stop");
        return status();
      },
      async screenshot(options) {
        log.push(`screenshot:${options?.format ?? "png"}`);
        return {
          data: new Uint8Array([137, 80, 78, 71]),
          mimeType: options?.format === "jpeg" ? "image/jpeg" : "image/png",
          width: options?.region?.width ?? 1280,
          height: options?.region?.height ?? 720,
        };
      },
      async click(input) {
        if (input.x !== undefined && input.y !== undefined) {
          cursor = { x: input.x, y: input.y };
        }
        log.push(`click:${input.x ?? ""},${input.y ?? ""},${input.button ?? "left"}`);
      },
      async doubleClick(input) {
        log.push(`doubleClick:${input.x ?? ""},${input.y ?? ""}`);
      },
      async tripleClick(input) {
        log.push(`tripleClick:${input.x ?? ""},${input.y ?? ""}`);
      },
      async rightClick(input) {
        log.push(`rightClick:${input.x ?? ""},${input.y ?? ""}`);
      },
      async middleClick(input) {
        log.push(`middleClick:${input.x ?? ""},${input.y ?? ""}`);
      },
      async mouseDown(input) {
        log.push(`mouseDown:${input?.button ?? "left"}`);
      },
      async mouseUp(input) {
        log.push(`mouseUp:${input?.button ?? "left"}`);
      },
      async move(input) {
        cursor = { x: input.x, y: input.y };
        log.push(`move:${input.x},${input.y}`);
      },
      async drag(input) {
        cursor = { x: input.endX, y: input.endY };
        log.push(`drag:${input.startX},${input.startY}->${input.endX},${input.endY}`);
      },
      async scroll(input) {
        log.push(`scroll:${input.direction ?? "down"}:${input.amount ?? 1}`);
      },
      async type(input) {
        log.push(`type:${input.text}`);
      },
      async key(input) {
        log.push(`key:${input.key}:${input.action ?? "press"}`);
      },
      async cursorPosition() {
        return cursor;
      },
      async screenSize() {
        return { width: 1280, height: 720, display: ":99" };
      },
      async windows() {
        return [
          { id: "0x01", title: "Chromium", x: 0, y: 0, width: 1280, height: 720, active: true },
        ];
      },
      async focusWindow(input) {
        log.push(`focusWindow:${input.id ?? input.title ?? ""}`);
      },
      async clipboardRead() {
        return clipboard;
      },
      async clipboardWrite(input) {
        clipboard = input.text;
        log.push(`clipboardWrite:${input.text}`);
      },
      async wait(input) {
        log.push(`wait:${input.durationMs}`);
      },
    },
  };
}

describe("DesktopRPC and WorkspaceClient over WebSocket", () => {
  let closeHarness: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await closeHarness?.();
    closeHarness = undefined;
  });

  it("drives desktop operations, bearer auth, and closed notification over WebSocket", async () => {
    const storage = new SQLiteTestStorage();
    const db = new Database(storage);
    initializeSchema(db, () => 1000);
    const { desktop, log } = createFakeDesktop();
    const rpc = createWorkspaceServer(db, fakeRunner, { desktop });

    let receivedAuth: string | undefined;
    const http: Server = createServer();
    const wss = new WebSocketServer({ server: http, path: "/api" });
    wss.on("connection", (ws, req) => {
      receivedAuth = req.headers.authorization;
      acceptWebSocketSession(ws, rpc);
    });
    await new Promise<void>((res) => http.listen(0, "127.0.0.1", res));
    const { port } = http.address() as AddressInfo;

    closeHarness = async () => {
      for (const client of wss.clients) client.terminate();
      await new Promise<void>((res) => wss.close(() => res()));
      await new Promise<void>((res) => http.close(() => res()));
      storage.close();
    };

    const client = createWorkspaceClient({
      url: `ws://127.0.0.1:${port}/api`,
      secret: "test-secret-token",
      WebSocketImpl: WebSocket as unknown as typeof globalThis.WebSocket,
    });

    try {
      const desktop = client.desktop;
      if (!desktop) throw new Error("expected desktop stub");
      const status = await desktop.status();
      expect(receivedAuth).toBe("Bearer test-secret-token");
      expect(status).toEqual({
        enabled: true,
        running: true,
        display: ":99",
        width: 1280,
        height: 720,
        depth: 24,
        vncPort: 5900,
        noVncPort: 6080,
        windowManager: "fluxbox",
      });

      const shot = await desktop.screenshot({ format: "png" });
      expect(shot.mimeType).toBe("image/png");
      expect(shot.width).toBe(1280);
      expect(Array.from(shot.data)).toEqual([137, 80, 78, 71]);

      await desktop.click({ x: 320, y: 240, button: "left" });
      expect(await desktop.cursorPosition()).toEqual({ x: 320, y: 240 });

      await desktop.type({ text: "hello world" });
      await desktop.key({ key: "Return" });
      await desktop.clipboardWrite({ text: "copied text" });
      expect(await desktop.clipboardRead()).toBe("copied text");

      const windows = await desktop.windows();
      expect(windows).toHaveLength(1);
      expect(windows[0].title).toBe("Chromium");

      expect(log).toEqual([
        "status",
        "screenshot:png",
        "click:320,240,left",
        "type:hello world",
        "key:Return:press",
        "clipboardWrite:copied text",
      ]);
    } finally {
      await client.close();
    }

    await expect(client.closed).resolves.toBeUndefined();
  });

  it("reports enabled=false and throws ENOSYS when desktop is not configured", async () => {
    const storage = new SQLiteTestStorage();
    const db = new Database(storage);
    initializeSchema(db, () => 1000);
    const rpc = createWorkspaceServer(db, fakeRunner);

    const http: Server = createServer();
    const wss = new WebSocketServer({ server: http, path: "/api" });
    wss.on("connection", (ws) => {
      acceptWebSocketSession(ws, rpc);
    });
    await new Promise<void>((res) => http.listen(0, "127.0.0.1", res));
    const { port } = http.address() as AddressInfo;

    closeHarness = async () => {
      for (const client of wss.clients) client.terminate();
      await new Promise<void>((res) => wss.close(() => res()));
      await new Promise<void>((res) => http.close(() => res()));
      storage.close();
    };

    const client = createWorkspaceClient({
      url: `ws://127.0.0.1:${port}/api`,
    });

    try {
      const desktop = client.desktop;
      if (!desktop) throw new Error("expected desktop stub");
      const status = await desktop.status();
      expect(status.enabled).toBe(false);
      expect(status.running).toBe(false);

      await expect(desktop.screenshot()).rejects.toThrow(/not enabled/i);
    } finally {
      await client.close();
    }
  });
});
