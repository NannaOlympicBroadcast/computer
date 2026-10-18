// `ws:browser`: a persistent Chrome browser for isolate JavaScript, over
// the Chrome DevTools Protocol.
//
//   import { send, attachToTarget } from "ws:browser";
//
// The browser belongs to the host. This module only needs something that
// can connect to it (see `BrowserSource`), such as `Browser` from
// `agents/browser`, so it doesn't depend on any one browser provider.

import type {
  WorkspaceModuleCallContext,
  WorkspaceModuleFactory,
  WorkspaceModuleFunctions,
  WorkspaceRuntimeValue,
} from "../runtime/types.js";

/**
 * A CDP connection to a browser, as `BrowserSource.connect` returns it.
 * `Browser` from `agents/browser` provides one.
 */
export interface BrowserCdp {
  /** Send a CDP command and resolve with its result, without the JSON-RPC envelope. */
  send(
    method: string,
    params?: Record<string, unknown>,
    options?: { sessionId?: string; timeoutMs?: number },
  ): Promise<unknown>;
  /** Attach to a target and resolve with the CDP session id, valid on this connection only. */
  attachToTarget(targetId: string, options?: { timeoutMs?: number }): Promise<string>;
  /** Recent protocol traffic, newest last. */
  getDebugLog(limit?: number): unknown[];
  /** Forget the protocol traffic recorded so far. */
  clearDebugLog(): void;
  /** Close the connection. The browser stays open. */
  disconnect(): void;
}

/** The CDP description a browser serves, as far as this module reads it. */
export interface BrowserCdpSpec {
  domains: Array<{ name: string; events: Array<{ event: string }> }>;
}

/** One connection to the browser for one scope. */
export interface BrowserConnection {
  /**
   * `true` when this scope worked in an earlier browser that has since been
   * replaced, so its tabs and logins are gone.
   */
  restarted: boolean;
  /** The tab this scope last worked in, if it recorded one. */
  activeTargetId?: string;
  /** The CDP connection. Closing it doesn't close the browser. */
  cdp: BrowserCdp;
  /** Record the tab this scope is working in, or clear it with `undefined`. */
  setActiveTarget(targetId: string | undefined): Promise<unknown>;
  /** The tabs other scopes are working in. */
  targetsInOtherScopes(): Promise<Set<string>>;
  /** The Chrome DevTools Protocol description the browser serves. */
  spec(): Promise<BrowserCdpSpec>;
}

/**
 * The browser the module drives. `Browser` from `agents/browser` has this
 * shape. `connect` reattaches to the browser, or replaces a lost one, and
 * opens a CDP connection for a scope.
 */
export interface BrowserSource {
  /** The browser's name, for log messages. */
  readonly name: string;
  /** Open a CDP connection for `scope`. */
  connect(options?: { scope?: string }): Promise<BrowserConnection>;
}

/** Options for {@link createBrowserModule}. */
export interface BrowserModuleOptions {
  /** The browser to drive. */
  readonly browser: BrowserSource;
  /**
   * Who is driving, when several conversations share one browser: runs with
   * the same scope share an active tab, and each scope keeps its own.
   * Cookies and logins are shared by every scope. Defaults to the
   * browser's own default.
   */
  readonly scope?: string;
  /**
   * The largest `Page.captureScreenshot` result `send` returns, measured as
   * JSON. Defaults to 1,000,000 bytes. Keep it under the backend's
   * `maxCapabilityBytes`.
   */
  readonly maxResultBytes?: number;
}

/** A tab a page opened on its own during an execution. */
export interface BrowserNewTab {
  targetId: string;
  url?: string;
  title?: string;
}

/**
 * What happened to the browser during one execution, beyond the code's own
 * result.
 */
export interface BrowserExecutionReport {
  /** The browser was replaced before this run; earlier page state is gone. */
  restarted: boolean;
  /** Tabs the page opened itself (popups, `target=_blank`). */
  newTabs: BrowserNewTab[];
  /**
   * The tab this scope was working in was closed by someone else (another
   * scope, or a person in Live View), so `"active"` will be a new blank tab.
   */
  tabClosed: boolean;
  /** Another scope is working in this scope's active tab too. */
  tabShared: boolean;
}

/** `sessionId` value that addresses the tab the agent is working in. */
export const ACTIVE_PAGE_SESSION = "active";

/**
 * `attachToTarget` returns `{ sessionId: "target:<targetId>" }`, a stable
 * handle rather than a connection-scoped CDP session id, so it keeps
 * working in later runs. `send` resolves it on the live socket.
 */
const ATTACH_HANDLE_PREFIX = "target:";

/** Chrome's JSON-RPC code for a CDP session id it doesn't know. */
const CDP_SESSION_NOT_FOUND = -32001;

/** `BrowserDriver#liveParams`: nothing to detach. */
const DETACHED = Symbol("detached");

/** Reports awaiting their tool call; bounded in case a caller never reads. */
const MAX_PENDING_REPORTS = 100;

/**
 * Commands that would end the browser. The host owns its lifetime, so the
 * model can't close it out from under the agent (and lose its logins).
 */
const BROWSER_LIFETIME_COMMANDS = new Set([
  "Browser.close",
  "Browser.crash",
  "Browser.crashGpuProcess",
]);

/** A CDP target id: for this module, a tab. */
type TargetId = string & { readonly __brand: "TargetId" };

/** A CDP session id from `Target.attachToTarget`, valid on one socket only. */
type LiveSessionId = string & { readonly __brand: "LiveSessionId" };

/** The stable `sessionId` handle `attachToTarget` gives the model. */
type AttachHandle = `${typeof ATTACH_HANDLE_PREFIX}${string}`;

interface TargetInfo {
  targetId: TargetId;
  type: string;
  url?: string;
  title?: string;
  /** The tab that opened this one (popups, `target=_blank` links). */
  openerId?: TargetId;
}

/** State for one run. Dropped when the run ends. */
interface ExecutionState {
  executionId: string;
  connected: BrowserConnection;
  /** Live CDP session per target, valid on this socket only. */
  attached: Map<TargetId, LiveSessionId>;
  /**
   * Tabs this run attached to, through `attachToTarget` or a raw
   * `Target.attachToTarget`. Their popups are this run's new tabs.
   */
  workedIn: Set<TargetId>;
  /** Page targets open when the run connected. */
  initialPages: Set<TargetId>;
  /** The tab `"active"` resolves to, decided on first use. */
  activeTargetId?: TargetId;
  /** Whether {@link activeTargetId} was decided (vs. never needed). */
  activeResolved: boolean;
  /** Tabs this run closed with `Target.closeTarget`. */
  closed: Set<TargetId>;
}

const RESTARTED_NOTICE =
  "The browser was restarted before this run (it expired or was closed): earlier tabs, logins, and page state are gone. Your code ran in a fresh browser, so navigate again before relying on page state.";

const TAB_CLOSED_NOTICE =
  'The tab you were working in was closed (by another conversation using this browser, or a person). `sessionId: "active"` now opens a blank tab, so navigate again before relying on page state.';

const TAB_SHARED_NOTICE =
  "Another conversation using this browser is also working in your tab, so its page may change between your runs. Open a tab of your own with Target.createTarget if you need one.";

/**
 * Lines telling the model what happened to its browser during a run: it
 * was restarted, its tab was closed by someone else, another scope is
 * working in its tab too, or the page opened tabs.
 */
function reportLines(report: BrowserExecutionReport | undefined): string[] {
  if (!report) return [];
  const lines = [
    report.restarted && RESTARTED_NOTICE,
    report.tabClosed && !report.restarted && TAB_CLOSED_NOTICE,
    report.tabShared && TAB_SHARED_NOTICE,
  ].filter((notice) => typeof notice === "string");
  if (report.newTabs.length > 0) {
    lines.push(`New tabs opened by the page: ${JSON.stringify(report.newTabs)}`);
  }
  return lines;
}

function browserRules(): string[] {
  return [
    "The browser persists between runs: tabs, cookies, and logins are still there next time. You never start or close it.",
    "If the browser was replaced (idle timeout, crash), standard error says so and earlier tabs and logins are gone. Before an action that matters (submitting a form, a purchase), check you're on the page you expect.",
    'Page-scoped commands (Page.*, Runtime.*, DOM.*, Input.*, Network.*, Emulation.*) need sessionId: "active", your tab, which is remembered between runs. Browser.* and Target.* commands take no sessionId.',
    "Other open tabs (Target.getTargets) may belong to other conversations using this browser: don't close, navigate, or attach to a tab you didn't open unless the user asks.",
    "Target.createTarget opens a tab and makes it active. To switch to another open tab, call attachToTarget({ targetId }); the sessionId it returns keeps working in later runs, while one from a raw Target.attachToTarget only works in the current run.",
    "Tabs a page opens itself (popups, target=_blank links) don't become active; standard error lists them.",
    "Runtime.evaluate: pass returnByValue: true, or objects come back as a remote reference with no value, and awaitPromise: true for async expressions. The value is at result.value. A thrown error doesn't reject: check exceptionDetails.",
    "Page.navigate returns before the page loads and doesn't throw when it fails: check errorText, then poll document.readyState with Runtime.evaluate until it is 'complete'.",
    "Pick out what you need inside Runtime.evaluate and return only that. A single send result over 1 MB (a full-page screenshot, say) fails the call.",
  ];
}

const DESCRIPTION = [
  "A persistent Chrome browser over the Chrome DevTools Protocol (CDP).",
  "- `send({ method, params?, sessionId?, timeoutMs? })` sends a CDP command and returns its result without the JSON-RPC envelope: `Page.navigate` returns `{ frameId, errorText? }`, `Runtime.evaluate` returns `{ result: { value }, exceptionDetails? }`.",
  "- `attachToTarget({ targetId })` makes an open tab active and returns `{ sessionId }`.",
  '- `spec()` returns the whole protocol (about 650 KB) as `{ domains: [{ name, commands, events, types }] }`. Filter it in code, for example `spec.domains.find((d) => d.name === "Page")`.',
  "- `getDebugLog({ limit? })` returns recent protocol traffic, for when a command fails or times out. `clearDebugLog()` clears it.",
  '- To look at the page, save a screenshot and open it with the `read` tool: `const { data } = await send({ method: "Page.captureScreenshot", sessionId: "active" }); await writeFile("/workspace/page.png", Buffer.from(data, "base64"));`, with `writeFile` from `node:fs/promises` and `Buffer` from `node:buffer`.',
  ...browserRules().map((rule) => `- ${rule}`),
].join("\n");

/**
 * Build the `ws:browser` host module over a persistent browser.
 *
 * It exports `send`, `attachToTarget`, `spec`, `getDebugLog` and
 * `clearDebugLog`. Each run gets its own CDP connection, opened on its
 * first call. When the run ends, the module saves the scope's active tab,
 * closes the connection, and writes what happened to the browser (a
 * restart, tabs the page opened) to standard error. The browser stays open.
 *
 * @param options - The browser, the scope to drive it in, and the size limit on screenshots.
 * @returns The module to pass as `modules["ws:browser"]`.
 */
export function createBrowserModule(options: BrowserModuleOptions): WorkspaceModuleFactory {
  const driver = new BrowserDriver(options);
  const running = new Set<string>();

  const begin = (context: WorkspaceModuleCallContext) => {
    const { executionId } = context;
    if (running.has(executionId)) return;
    running.add(executionId);
    context.defer(async () => {
      running.delete(executionId);
      try {
        await driver.end(executionId);
      } finally {
        for (const line of reportLines(driver.takeReport(executionId))) context.log(line);
      }
    });
  };

  const functions: Record<string, WorkspaceModuleFunctions[string]> = {};
  for (const name of BROWSER_FUNCTION_NAMES) {
    functions[name] = async ([value], context) => {
      begin(context);
      return driver.call(context.executionId, name, value);
    };
  }
  const create = (): WorkspaceModuleFunctions => functions;
  return Object.assign(create, { description: DESCRIPTION });
}

/**
 * Drives one persistent browser over CDP, with one connection per run.
 *
 * The model never manages sessions: every run reattaches to the browser,
 * or gets a replacement reported as restarted, and `sessionId: "active"`
 * addresses the tab the scope last worked in. The active tab is stored
 * per scope, so it survives between runs for as long as the tab does, and
 * one scope's runs never land in another scope's tab unless the model
 * attaches to it.
 */
class BrowserDriver {
  readonly #browser: BrowserSource;
  readonly #scope: string | undefined;
  readonly #maxResultBytes: number;
  #states = new Map<string, ExecutionState>();
  #connecting = new Map<string, Promise<ExecutionState>>();
  #reports = new Map<string, BrowserExecutionReport>();

  constructor(options: BrowserModuleOptions) {
    this.#browser = options.browser;
    this.#scope = options.scope;
    this.#maxResultBytes = options.maxResultBytes ?? 1_000_000;
  }

  /** Answer one call from `executionId`'s code. */
  async call(
    executionId: string,
    name: BrowserFunctionName,
    value: WorkspaceRuntimeValue | undefined,
  ): Promise<unknown> {
    const input = parseArguments(name, value);
    switch (name) {
      case "send":
        return this.#send(executionId, input);
      case "attachToTarget":
        return this.#attachToTarget(executionId, input);
      case "spec":
        return (await this.#state(executionId)).connected.spec();
      case "getDebugLog": {
        const state = await this.#state(executionId);
        return state.connected.cdp.getDebugLog(optionalNumber(input, "limit", name));
      }
      case "clearDebugLog": {
        const state = await this.#state(executionId);
        state.connected.cdp.clearDebugLog();
        return null;
      }
    }
  }

  /**
   * The run is over: note tabs the page opened, save the scope's active
   * tab, note whether another scope shares it, and drop the socket. The
   * browser stays alive.
   */
  async end(executionId: string): Promise<void> {
    const state = this.#states.get(executionId);
    if (!state) return;
    this.#states.delete(executionId);
    try {
      const open = await this.#recordNewTabs(executionId, state);
      const active = await this.#saveActiveTarget(state, open);
      if (active && state.activeResolved) {
        await this.#recordSharedTab(state, active);
      }
    } finally {
      state.connected.cdp.disconnect();
    }
  }

  /**
   * Take (and forget) what happened to the browser during an execution.
   * `undefined` when the execution never touched the browser.
   */
  takeReport(executionId: string): BrowserExecutionReport | undefined {
    const report = this.#reports.get(executionId);
    this.#reports.delete(executionId);
    return report;
  }

  async #send(executionId: string, args: Arguments): Promise<unknown> {
    const method = requiredString(args, "method", "send");
    const params = optionalObject(args, "params", "send");
    const sessionId = optionalString(args, "sessionId", "send");
    const timeoutMs = optionalNumber(args, "timeoutMs", "send");
    if (BROWSER_LIFETIME_COMMANDS.has(method)) {
      throw new Error(
        `${method} is not available: this browser is managed for you ` +
          `and persists between runs. To close a tab, send ` +
          `Target.closeTarget with its targetId.`,
      );
    }
    const state = await this.#state(executionId);
    const live = await this.#resolveSessionId(state, sessionId);
    const liveParams = this.#liveParams(state, method, params);
    if (liveParams === DETACHED) return {};
    let result: unknown;
    try {
      result = await state.connected.cdp.send(method, liveParams, {
        sessionId: live,
        timeoutMs,
      });
    } catch (error) {
      throw await this.#teach(state, error, method, sessionId);
    }
    this.#observe(state, method, liveParams, result);
    if (method === "Page.captureScreenshot") {
      this.#assertFits(result);
    }
    return result;
  }

  async #attachToTarget(executionId: string, args: Arguments): Promise<{ sessionId: string }> {
    // SAFETY: Any string the caller passes is a target id to Chrome, which rejects ones it doesn't know.
    const targetId = requiredString(args, "targetId", "attachToTarget") as TargetId;
    const timeoutMs = optionalNumber(args, "timeoutMs", "attachToTarget");
    const state = await this.#state(executionId);
    await this.#attach(state, targetId, timeoutMs);
    this.#setActive(state, targetId);
    return { sessionId: attachHandle(targetId) };
  }

  /**
   * The JavaScript backend caps each host call's response, so a result over
   * the limit fails with a generic error. A full-page screenshot is the
   * usual culprit, so say how to take a smaller one instead.
   */
  #assertFits(result: unknown): void {
    // Measure the result as JSON, not just the data, so a screenshot just
    // under the limit can't slip past with its JSON framing.
    const size = JSON.stringify(result ?? null).length;
    if (size <= this.#maxResultBytes) return;
    const megabytes = (size / 1_000_000).toFixed(1);
    const limit = (this.#maxResultBytes / 1_000_000).toFixed(0);
    throw new Error(
      `The screenshot result is ${megabytes} MB, over the ${limit} MB limit on a ` +
        `send result. Capture just the viewport (no captureBeyondViewport ` +
        `or clip larger than the window), or pass format: "jpeg" with ` +
        `quality: 60.`,
    );
  }

  /**
   * Connect once per run. Concurrent first calls (model code that uses
   * Promise.all despite the instructions) share one connect.
   */
  #state(executionId: string): Promise<ExecutionState> {
    const existing = this.#states.get(executionId);
    if (existing) return Promise.resolve(existing);
    const inFlight = this.#connecting.get(executionId);
    if (inFlight) return inFlight;
    const promise = this.#connect(executionId).finally(() => {
      this.#connecting.delete(executionId);
    });
    this.#connecting.set(executionId, promise);
    return promise;
  }

  async #connect(executionId: string): Promise<ExecutionState> {
    const connected = await this.#browser.connect(
      this.#scope === undefined ? undefined : { scope: this.#scope },
    );
    let initialPages: TargetInfo[];
    try {
      initialPages = await this.#pages(connected.cdp);
    } catch (error) {
      connected.cdp.disconnect();
      throw error;
    }
    const state: ExecutionState = {
      executionId,
      connected,
      attached: new Map(),
      workedIn: new Set(),
      initialPages: new Set(initialPages.map((page) => page.targetId)),
      activeResolved: false,
      closed: new Set(),
    };
    this.#states.set(executionId, state);
    this.#report(executionId, connected.restarted);
    return state;
  }

  #report(executionId: string, restarted: boolean): BrowserExecutionReport {
    let report = this.#reports.get(executionId);
    if (!report) {
      report = { restarted, newTabs: [], tabClosed: false, tabShared: false };
      this.#reports.set(executionId, report);
      if (this.#reports.size > MAX_PENDING_REPORTS) {
        const oldest = this.#reports.keys().next().value;
        if (oldest !== undefined) this.#reports.delete(oldest);
      }
    }
    // A replacement means earlier page state is gone.
    report.restarted ||= restarted;
    return report;
  }

  /**
   * Add tabs the page opened this run to its report, and drop
   * earlier ones that have since closed: `newTabs` lists page-opened tabs
   * still open when the run ends. Returns the open
   * tabs, or `undefined` when the browser couldn't be asked.
   */
  async #recordNewTabs(
    executionId: string,
    state: ExecutionState,
  ): Promise<Set<TargetId> | undefined> {
    let pages: TargetInfo[];
    try {
      pages = await this.#pages(state.connected.cdp);
    } catch (error) {
      this.#warn("list the open tabs", error);
      return undefined;
    }
    const report = this.#report(executionId, state.connected.restarted);
    const opened = new Set<string>(report.newTabs.map((tab) => tab.targetId));
    // A new tab is this run's when its opener is a tab this run
    // worked in, or another of its new tabs (a popup's popup). Chrome sets
    // openerId only on tabs a page opened, never on Target.createTarget
    // tabs, and a popup another scope's page opened meanwhile has that
    // scope's tab as its opener.
    let grew = true;
    while (grew) {
      grew = false;
      for (const page of pages) {
        const opener = page.openerId;
        if (!opener || opened.has(page.targetId) || state.initialPages.has(page.targetId)) {
          continue;
        }
        if (state.workedIn.has(opener) || opened.has(opener)) {
          opened.add(page.targetId);
          grew = true;
        }
      }
    }
    report.newTabs = pages
      .filter((page) => opened.has(page.targetId))
      .map(({ targetId, url, title }) => ({ targetId, url, title }));
    return new Set(pages.map((page) => page.targetId));
  }

  /**
   * Save the tab this run settled on, forgetting one that has since closed,
   * and return it. Without the list of open tabs, save the choice
   * unchecked: the next execution checks the stored tab is still open
   * before using it.
   */
  async #saveActiveTarget(
    state: ExecutionState,
    open: Set<TargetId> | undefined,
  ): Promise<TargetId | undefined> {
    const stored = state.connected.activeTargetId as TargetId | undefined;
    // A run that never used "active" still sees the stored tab is gone;
    // say so now, since the next run won't know there was one.
    if (!state.activeResolved && stored && open && !open.has(stored) && !state.closed.has(stored)) {
      this.#report(state.executionId, state.connected.restarted).tabClosed = true;
    }
    const candidate = state.activeResolved ? state.activeTargetId : stored;
    const active = candidate && (!open || open.has(candidate)) ? candidate : undefined;
    if (active === stored) return active;
    try {
      await state.connected.setActiveTarget(active);
    } catch (error) {
      this.#warn("save the active tab", error);
    }
    return active;
  }

  /** Report when another scope is working in this run's tab too. */
  async #recordSharedTab(state: ExecutionState, active: TargetId): Promise<void> {
    try {
      const others = await state.connected.targetsInOtherScopes();
      if (others.has(active)) {
        this.#report(state.executionId, state.connected.restarted).tabShared = true;
      }
    } catch (error) {
      this.#warn("check whether the active tab is shared", error);
    }
  }

  #warn(action: string, error: unknown): void {
    console.warn(`[ws:browser] Failed to ${action} for browser "${this.#browser.name}"`, error);
  }

  async #pages(cdp: BrowserCdp): Promise<TargetInfo[]> {
    const result = (await cdp.send("Target.getTargets")) as {
      targetInfos?: TargetInfo[];
    };
    return (result?.targetInfos ?? []).filter((info) => info.type === "page");
  }

  async #resolveSessionId(
    state: ExecutionState,
    sessionId: string | undefined,
  ): Promise<LiveSessionId | undefined> {
    if (sessionId === ACTIVE_PAGE_SESSION) {
      return this.#attach(state, await this.#activeTarget(state));
    }
    if (isAttachHandle(sessionId)) {
      return this.#attach(state, targetOfHandle(sessionId));
    }
    // Omitted, or a raw CDP session id the model got from send().
    return sessionId as LiveSessionId | undefined;
  }

  /**
   * Decide which tab `"active"` means, once per run: the scope's stored tab
   * if it is still open, else a new blank tab. Never a tab the scope didn't
   * open, even a blank one: it may be another scope's, or a popup.
   */
  async #activeTarget(state: ExecutionState): Promise<TargetId> {
    if (state.activeTargetId) return state.activeTargetId;
    const { connected } = state;
    const pages = await this.#pages(connected.cdp);
    const stored = connected.activeTargetId as TargetId | undefined;
    let targetId = pages.find((page) => page.targetId === stored)?.targetId;
    if (!targetId && stored && !state.closed.has(stored)) {
      this.#report(state.executionId, connected.restarted).tabClosed = true;
    }
    if (!targetId) {
      const created = (await connected.cdp.send("Target.createTarget", {
        url: "about:blank",
      })) as { targetId: TargetId };
      targetId = created.targetId;
    }
    this.#setActive(state, targetId);
    return targetId;
  }

  #setActive(state: ExecutionState, targetId: TargetId | undefined): void {
    state.activeTargetId = targetId;
    state.activeResolved = true;
  }

  async #attach(
    state: ExecutionState,
    targetId: TargetId,
    timeoutMs?: number,
  ): Promise<LiveSessionId> {
    const existing = state.attached.get(targetId);
    if (existing) return existing;
    const live = (await state.connected.cdp.attachToTarget(targetId, {
      timeoutMs,
    })) as LiveSessionId;
    state.attached.set(targetId, live);
    state.workedIn.add(targetId);
    return live;
  }

  /** Track tab changes the model makes through raw Target commands. */
  #observe(
    state: ExecutionState,
    method: string,
    params: Record<string, unknown> | undefined,
    result: unknown,
  ): void {
    const targetId =
      typeof params?.targetId === "string" ? (params.targetId as TargetId) : undefined;
    if (method === "Target.createTarget") {
      const created = (result as { targetId?: unknown } | undefined)?.targetId;
      if (typeof created === "string") {
        this.#setActive(state, created as TargetId);
      }
    } else if (method === "Target.attachToTarget" && targetId) {
      this.#setActive(state, targetId);
      state.workedIn.add(targetId);
    } else if (method === "Target.closeTarget" && targetId) {
      state.attached.delete(targetId);
      state.closed.add(targetId);
      // The next "active" use picks a tab afresh.
      if (state.activeTargetId === targetId) state.activeTargetId = undefined;
    } else if (method === "Target.detachFromTarget") {
      // Forget a session the model detached, so the next use reattaches.
      for (const [target, live] of state.attached) {
        if (target === targetId || live === params?.sessionId) {
          state.attached.delete(target);
        }
      }
    }
  }

  /**
   * Swap a handle in `Target.detachFromTarget`'s `sessionId` param for the
   * live CDP session id. Returns {@link DETACHED} when the handle's tab isn't
   * attached on this socket, so there is nothing to detach.
   */
  #liveParams(
    state: ExecutionState,
    method: string,
    params: Record<string, unknown> | undefined,
  ): Record<string, unknown> | undefined | typeof DETACHED {
    const handle = params?.sessionId;
    if (method !== "Target.detachFromTarget" || typeof handle !== "string") {
      return params;
    }
    if (!isAttachHandle(handle)) return params;
    const live = state.attached.get(targetOfHandle(handle));
    return live ? { ...params, sessionId: live } : DETACHED;
  }

  /**
   * Turn the common protocol mistakes into instructions: sending an
   * event as a command, and a page-scoped command without a session.
   */
  async #teach(
    state: ExecutionState,
    error: unknown,
    method: string,
    sessionId: string | undefined,
  ): Promise<unknown> {
    const code = protocolErrorCode(error);
    if (code === undefined) return error;
    const message = error instanceof Error ? error.message : String(error);
    if (
      code === CDP_SESSION_NOT_FOUND &&
      sessionId &&
      sessionId !== ACTIVE_PAGE_SESSION &&
      !isAttachHandle(sessionId)
    ) {
      return new Error(
        `${message}. CDP session ids don't carry over between runs. ` +
          `Use sessionId: "active" for the current tab, or the handle from ` +
          `attachToTarget({ targetId }) for another tab.`,
      );
    }
    if (code !== CDP_METHOD_NOT_FOUND) return error;
    if (await this.#isEvent(state, method)) {
      return new Error(
        `${message}. '${method}' is a CDP *event*, not a command, so it ` +
          `cannot be sent. To wait for page state, poll instead (e.g. ` +
          `Runtime.evaluate of document.readyState until "complete").`,
      );
    }
    if (!sessionId) {
      return new Error(
        `${message}. '${method}' is page-scoped: pass sessionId: ` +
          `"active" to run it in the current tab: ` +
          `send({ method: "${method}", params, sessionId: "active" }).`,
      );
    }
    return error;
  }

  async #isEvent(state: ExecutionState, method: string): Promise<boolean> {
    try {
      const spec = await state.connected.spec();
      const domain = method.split(".")[0];
      return spec.domains.some(
        (d) => d.name === domain && d.events.some((e) => e.event === method),
      );
    } catch {
      return false;
    }
  }
}

function attachHandle(targetId: TargetId): AttachHandle {
  return `${ATTACH_HANDLE_PREFIX}${targetId}`;
}

function isAttachHandle(sessionId: string | undefined): sessionId is AttachHandle {
  return sessionId?.startsWith(ATTACH_HANDLE_PREFIX) ?? false;
}

function targetOfHandle(handle: AttachHandle): TargetId {
  return handle.slice(ATTACH_HANDLE_PREFIX.length) as TargetId;
}

/** Chrome's JSON-RPC code for a method it doesn't know. */
const CDP_METHOD_NOT_FOUND = -32601;

/** The JSON-RPC code of a CDP protocol error, or `undefined` for any other error. */
function protocolErrorCode(error: unknown): number | undefined {
  if (!(error instanceof Error)) return undefined;
  const code: unknown = Reflect.get(error, "code");
  return typeof code === "number" ? code : undefined;
}

type BrowserFunctionName = "send" | "attachToTarget" | "spec" | "getDebugLog" | "clearDebugLog";

const BROWSER_FUNCTION_NAMES: readonly BrowserFunctionName[] = [
  "send",
  "attachToTarget",
  "spec",
  "getDebugLog",
  "clearDebugLog",
];

type Arguments = Readonly<Record<string, WorkspaceRuntimeValue>>;

/** A call's single options object. An omitted argument counts as `{}`. */
function parseArguments(
  name: BrowserFunctionName,
  value: WorkspaceRuntimeValue | undefined,
): Arguments {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`ws:browser ${name} takes one options object.`);
  }
  return value;
}

function requiredString(args: Arguments, key: string, name: string): string {
  const value = args[key];
  if (typeof value !== "string" || value === "") {
    throw new Error(`ws:browser ${name} needs \`${key}\`, a string.`);
  }
  return value;
}

function optionalString(args: Arguments, key: string, name: string): string | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string")
    throw new Error(`ws:browser ${name}: \`${key}\` must be a string.`);
  return value;
}

function optionalNumber(args: Arguments, key: string, name: string): number | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`ws:browser ${name}: \`${key}\` must be a positive number.`);
  }
  return value;
}

function optionalObject(
  args: Arguments,
  key: string,
  name: string,
): Record<string, unknown> | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`ws:browser ${name}: \`${key}\` must be an object.`);
  }
  return value;
}
