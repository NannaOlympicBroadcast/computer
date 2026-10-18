import { describe, expect, it } from "vitest";

import type {
  WorkspaceModuleCallContext,
  WorkspaceModuleFunctions,
  WorkspaceModuleHost,
  WorkspaceRuntimeValue,
} from "../runtime/types.js";
import {
  createBrowserModule,
  type BrowserCdp,
  type BrowserConnection,
  type BrowserModuleOptions,
  type BrowserSource,
} from "./browser.js";

// SAFETY: The browser module never touches the host's Git, Artifacts, or runtime.
const host = {} as WorkspaceModuleHost;

class ProtocolError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

interface Tab {
  targetId: string;
  type: "page";
  url: string;
  openerId?: string;
}

// One browser: tabs shared by every connection, an active tab per scope,
// and Chrome's errors for an unknown session or a page command without one.
class FakeBrowser implements BrowserSource {
  readonly name = "work";
  tabs: Tab[] = [{ targetId: "target-1", type: "page", url: "about:blank" }];
  active = new Map<string, string | undefined>();
  connections: { disconnected: boolean }[] = [];
  restartNext = false;
  screenshotBytes = 10;
  #nextTarget = 1;
  #nextSession = 0;
  #sessions = new Map<string, string>();

  addTab(url: string, openerId?: string): string {
    const targetId = `target-${++this.#nextTarget}`;
    this.tabs.push({ targetId, type: "page", url, ...(openerId ? { openerId } : {}) });
    return targetId;
  }

  async connect(options: { scope?: string } = {}): Promise<BrowserConnection> {
    const scope = options.scope ?? "shared";
    const restarted = this.restartNext;
    if (restarted) {
      this.restartNext = false;
      this.tabs = [];
      this.active.clear();
    }
    const state = { disconnected: false };
    this.connections.push(state);
    const sessions = new Set<string>();
    const cdp: BrowserCdp = {
      send: async (method, params = {}, sendOptions = {}) => {
        if (state.disconnected) throw new Error("socket closed");
        return this.#handle(method, params, sendOptions.sessionId);
      },
      attachToTarget: async (targetId) => {
        const sessionId = `cdp-${++this.#nextSession}`;
        this.#sessions.set(sessionId, targetId);
        sessions.add(sessionId);
        return sessionId;
      },
      getDebugLog: () => [{ at: "now", type: "send" }],
      clearDebugLog: () => {},
      disconnect: () => {
        state.disconnected = true;
        for (const sessionId of sessions) this.#sessions.delete(sessionId);
      },
    };
    return {
      restarted,
      activeTargetId: this.active.get(scope),
      cdp,
      setActiveTarget: async (targetId) => {
        this.active.set(scope, targetId);
        return true;
      },
      targetsInOtherScopes: async () =>
        new Set(
          [...this.active]
            .filter(([other, target]) => other !== scope && target !== undefined)
            .map(([, target]) => target as string),
        ),
      spec: async () => ({
        domains: [{ name: "Page", events: [{ event: "Page.loadEventFired" }] }],
      }),
    };
  }

  #handle(method: string, params: Record<string, unknown>, sessionId: string | undefined) {
    switch (method) {
      case "Target.getTargets":
        return { targetInfos: this.tabs };
      case "Target.createTarget":
        return { targetId: this.addTab(String(params.url ?? "")) };
      case "Target.closeTarget":
        this.tabs = this.tabs.filter((tab) => tab.targetId !== params.targetId);
        return { success: true };
      case "Target.attachToTarget": {
        const id = `cdp-${++this.#nextSession}`;
        this.#sessions.set(id, String(params.targetId));
        return { sessionId: id };
      }
      default:
        if (sessionId && !this.#sessions.has(sessionId)) {
          throw new ProtocolError(-32001, "Session with given id not found.");
        }
        if (!sessionId) throw new ProtocolError(-32601, `'${method}' wasn't found`);
        if (method === "Page.captureScreenshot") return { data: "x".repeat(this.screenshotBytes) };
        if (method === "Runtime.evaluate") {
          const target = this.#sessions.get(sessionId);
          if (params.expression === "openPopup()") this.addTab("https://popup.example/", target);
          return { result: { value: target } };
        }
        return {};
    }
  }
}

function setup(options: Partial<BrowserModuleOptions> = {}) {
  const browser = new FakeBrowser();
  const module = createBrowserModule({ browser, ...options });
  const functions: WorkspaceModuleFunctions = module(host);
  let runs = 0;

  // Run `calls` as one execution, as the JavaScript backend does: every
  // call has the run's id, and deferred functions run last first at the end.
  async function run(calls: Array<[name: string, args?: WorkspaceRuntimeValue]>) {
    const logs: string[] = [];
    const deferred: Array<() => unknown> = [];
    const context: WorkspaceModuleCallContext = {
      executionId: `run-${++runs}`,
      signal: new AbortController().signal,
      deadline: Date.now() + 60_000,
      access: "read-write",
      resolvePath: async (path) => path,
      log: (text) => logs.push(text),
      defer: (fn) => deferred.push(fn),
    };
    const results: unknown[] = [];
    let error: unknown;
    try {
      for (const [name, args] of calls) {
        results.push(await functions[name](args === undefined ? [] : [args], context));
      }
    } catch (caught) {
      error = caught;
    }
    while (deferred.length > 0) await deferred.pop()?.();
    return { results, error, logs };
  }

  return { browser, module, functions, run };
}

const evaluate = (expression: string): WorkspaceRuntimeValue => ({
  method: "Runtime.evaluate",
  params: { expression },
  sessionId: "active",
});

describe("ws:browser", () => {
  it("exports the browser calls and describes them for a model", () => {
    const { functions, module } = setup();
    expect(Object.keys(functions).sort()).toEqual([
      "attachToTarget",
      "clearDebugLog",
      "getDebugLog",
      "send",
      "spec",
    ]);
    expect(module.description).toContain("send({ method");
    expect(module.description).toContain("standard error");
    expect(module.description).not.toContain("cdp.");
  });

  it("opens a tab for the scope and keeps it between runs", async () => {
    const t = setup();
    const first = await t.run([["send", evaluate("1")]]);
    expect(first.error).toBeUndefined();
    // Never the browser's initial blank tab, which may be another scope's.
    expect(first.results[0]).toEqual({ result: { value: "target-2" } });
    expect(t.browser.active.get("shared")).toBe("target-2");
    expect(t.browser.connections.every((connection) => connection.disconnected)).toBe(true);

    const second = await t.run([["send", evaluate("1")]]);
    expect(second.results[0]).toEqual({ result: { value: "target-2" } });
  });

  it("keeps scopes in their own tabs", async () => {
    const shared = setup();
    const other = createBrowserModule({ browser: shared.browser, scope: "other" })(host);
    await shared.run([["send", evaluate("1")]]);
    const deferred: Array<() => unknown> = [];
    const result = await other.send([evaluate("1")], {
      executionId: "other-run",
      signal: new AbortController().signal,
      deadline: Date.now() + 60_000,
      access: "read-write",
      resolvePath: async (path) => path,
      log: () => {},
      defer: (fn) => deferred.push(fn),
    });
    while (deferred.length > 0) await deferred.pop()?.();
    expect(result).toEqual({ result: { value: "target-3" } });
    expect(shared.browser.active).toEqual(
      new Map([
        ["shared", "target-2"],
        ["other", "target-3"],
      ]),
    );
  });

  it("returns an attach handle that works in later runs", async () => {
    const t = setup();
    const first = await t.run([["attachToTarget", { targetId: "target-1" }]]);
    expect(first.results[0]).toEqual({ sessionId: "target:target-1" });
    const second = await t.run([
      [
        "send",
        { method: "Runtime.evaluate", params: { expression: "1" }, sessionId: "target:target-1" },
      ],
    ]);
    expect(second.results[0]).toEqual({ result: { value: "target-1" } });
  });

  it("writes tabs the page opened to standard error", async () => {
    const t = setup();
    const { logs } = await t.run([["send", evaluate("openPopup()")]]);
    expect(logs).toEqual([
      'New tabs opened by the page: [{"targetId":"target-3","url":"https://popup.example/"}]',
    ]);
  });

  it("says so on standard error when the browser was replaced", async () => {
    const t = setup();
    t.browser.restartNext = true;
    const { logs, error } = await t.run([["send", { method: "Target.getTargets" }]]);
    expect(error).toBeUndefined();
    expect(logs).toEqual([expect.stringContaining("The browser was restarted before this run")]);
  });

  it("explains a page-scoped command sent without a session", async () => {
    const t = setup();
    const { error } = await t.run([["send", { method: "Page.navigate" }]]);
    expect(String(error)).toContain('pass sessionId: "active"');
  });

  it("explains a CDP session id from an earlier run", async () => {
    const t = setup();
    const { error } = await t.run([
      ["send", { method: "Runtime.evaluate", params: {}, sessionId: "cdp-99" }],
    ]);
    expect(String(error)).toContain("CDP session ids don't carry over between runs");
  });

  it("refuses an oversized screenshot with how to take a smaller one", async () => {
    const t = setup({ maxResultBytes: 50 });
    t.browser.screenshotBytes = 100;
    const { error } = await t.run([
      ["send", { method: "Page.captureScreenshot", sessionId: "active" }],
    ]);
    expect(String(error)).toContain("Capture just the viewport");
  });

  it("refuses bad arguments and commands that would end the browser", async () => {
    const t = setup();
    const missing = await t.run([["send", { params: {} }]]);
    expect(String(missing.error)).toContain("send needs `method`");
    const notObject = await t.run([["send", "Page.navigate"]]);
    expect(String(notObject.error)).toContain("takes one options object");
    const close = await t.run([["send", { method: "Browser.close" }]]);
    expect(String(close.error)).toContain("Browser.close is not available");
  });

  it("leaves the browser alone for a run that never called it", async () => {
    const t = setup();
    const { logs } = await t.run([]);
    expect(logs).toEqual([]);
    expect(t.browser.connections).toEqual([]);
  });
});
