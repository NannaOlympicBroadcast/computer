// TailscaleComputerdBackend & Tailscale peer discovery helpers.
//
// Connects a Workspace to a `computerd` instance reachable over a
// Tailscale virtual LAN (Tailnet) by peer hostname, MagicDNS name,
// Tailscale IP (100.x.y.z / fd7a:115c:a1e0::), or automatic Tailnet
// probe. Uses `process.getBuiltinModule("node:child_process")` when
// querying the local `tailscale` CLI so importing this module remains
// safe inside workerd.

import type { BackendHandle, WorkspaceBackend } from "../../backend.js";
import { ComputerdBackend, waitForComputerd } from "./computerd-backend.js";

export interface TailscalePeerInfo {
  /** Node ID from `tailscale status --json`. */
  id: string;
  /** Short machine host name (e.g. `gpu-workstation`). */
  hostName: string;
  /** Full MagicDNS name without trailing dot (e.g. `gpu-workstation.tail1234.ts.net`). */
  dnsName: string;
  /** Tailscale IPv4 and IPv6 addresses assigned to the peer. */
  tailscaleIps: string[];
  /** Operating system reported by Tailscale. */
  os: string;
  /** Whether the peer is currently online on the Tailnet. */
  online: boolean;
  /** Whether this entry represents the local machine (`Self`). */
  isSelf?: boolean;
  /** Optional probe result if `probeComputerdPort` was specified. */
  computerd?: {
    reachable: boolean;
    url: string;
    noVncUrl: string;
  };
}

export interface TailscaleDiscoverOptions {
  /** Path to the `tailscale` CLI binary. Defaults to `"tailscale"` (with Windows fallback). */
  tailscaleBin?: string;
  /** Include offline peers in the returned list. Defaults to `false`. */
  includeOffline?: boolean;
  /** Include the local `Self` node in the returned list. Defaults to `true`. */
  includeSelf?: boolean;
  /**
   * When set, probes `http://<peer>:<probeComputerdPort>/health` on each
   * online peer and populates `peer.computerd`.
   */
  probeComputerdPort?: number;
  /** Timeout in milliseconds for each `/health` probe. Defaults to 1500ms. */
  probeTimeoutMs?: number;
  /** noVNC port used when constructing `noVncUrl`. Defaults to 6080. */
  noVncPort?: number;
  /** Custom command runner for testing. */
  execCommand?: (file: string, args: readonly string[]) => Promise<string>;
}

export interface TailscaleComputerdBackendOptions {
  /** Stable backend identifier. Defaults to `"tailscale"`. */
  id?: string;
  /**
   * Target Tailscale peer: a short hostname (`"ubuntu-desktop"`), MagicDNS
   * name (`"ubuntu-desktop.tailnet.ts.net"`), Tailscale IP (`"100.101.102.103"`),
   * or full URL (`"https://ubuntu-desktop.tailnet.ts.net"`).
   * If omitted, the backend scans online Tailnet peers for the first
   * reachable `computerd` instance on `port`.
   */
  peer?: string;
  /** `computerd` HTTP/WebSocket port on the remote peer. Defaults to `8080`. */
  port?: number;
  /** Protocol to use when `peer` is a host or IP. Defaults to `"http"`. */
  protocol?: "http" | "https";
  /** Prefer MagicDNS name over Tailscale IPv4 when resolving via CLI. Defaults to `false`. */
  preferMagicDns?: boolean;
  /** Bearer token matching `RPC_CLIENT_SECRET` on the remote `computerd`. */
  secret?: string;
  /** Extra HTTP headers sent on `/api` and `/health`. */
  headers?: Record<string, string>;
  /** Wait for `/health` before connecting. Defaults to `true`. */
  probeHealth?: boolean;
  /** Timeout in milliseconds when waiting for `/health`. Defaults to `15_000`. */
  readyTimeoutMs?: number;
  /** noVNC port on the remote peer (for helper URL generation). Defaults to `6080`. */
  noVncPort?: number;
  /** Path to the `tailscale` CLI binary. */
  tailscaleBin?: string;
  /** Human-readable backend description for agent tool prompts. */
  description?: string;
  /** Custom command runner for testing. */
  execCommand?: (file: string, args: readonly string[]) => Promise<string>;
}

type ExecFileFn = (
  file: string,
  args: readonly string[],
  options: { timeout?: number },
  callback: (error: Error | null, stdout: string, stderr: string) => void,
) => unknown;

async function defaultExecCommand(file: string, args: readonly string[]): Promise<string> {
  const proc = (
    globalThis as {
      process?: { platform?: string; getBuiltinModule?: (id: string) => unknown };
    }
  ).process;
  const cp = proc?.getBuiltinModule?.("node:child_process") as
    | { execFile?: ExecFileFn }
    | undefined;
  const run = cp?.execFile;
  if (!run) {
    throw new Error("Tailscale CLI discovery requires Node.js (`node:child_process`).");
  }

  const candidates =
    file === "tailscale" && proc?.platform === "win32"
      ? ["tailscale", "tailscale.exe", "C:\\Program Files\\Tailscale\\tailscale.exe"]
      : [file];

  let lastError: Error | undefined;
  for (const bin of candidates) {
    try {
      return await new Promise<string>((resolve, reject) => {
        run(bin, args, { timeout: 8_000 }, (error, stdout, stderr) => {
          if (error) {
            reject(
              new Error(`${bin} ${args.join(" ")} failed: ${stderr?.trim() || error.message}`),
            );
          } else {
            resolve(String(stdout));
          }
        });
      });
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
    }
  }
  throw lastError ?? new Error(`Failed to execute ${file}`);
}

interface RawTailscaleNode {
  ID?: string;
  HostName?: string;
  DNSName?: string;
  TailscaleIPs?: string[];
  OS?: string;
  Online?: boolean;
}

interface RawTailscaleStatus {
  Self?: RawTailscaleNode;
  Peer?: Record<string, RawTailscaleNode>;
}

function normalizeNode(raw: RawTailscaleNode, isSelf = false): TailscalePeerInfo {
  const dnsName = (raw.DNSName ?? "").replace(/\.$/, "");
  return {
    id: String(raw.ID ?? ""),
    hostName: String(raw.HostName ?? ""),
    dnsName,
    tailscaleIps: Array.isArray(raw.TailscaleIPs) ? raw.TailscaleIPs.map(String) : [],
    os: String(raw.OS ?? ""),
    online: raw.Online ?? isSelf,
    ...(isSelf ? { isSelf: true } : {}),
  };
}

function formatHostForUrl(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

function pickPeerAddress(peer: TailscalePeerInfo, preferMagicDns = false): string {
  if (preferMagicDns && peer.dnsName) {
    return peer.dnsName;
  }
  const ipv4 = peer.tailscaleIps.find((ip) => !ip.includes(":"));
  if (ipv4) return ipv4;
  if (peer.dnsName) return peer.dnsName;
  if (peer.tailscaleIps.length > 0) return peer.tailscaleIps[0];
  return peer.hostName;
}

async function probeHealthEndpoint(url: string, timeoutMs: number): Promise<boolean> {
  const healthUrl = new URL("/health", url.endsWith("/") ? url : `${url}/`).toString();
  try {
    const res = await fetch(healthUrl, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Queries `tailscale status --json` and returns nodes in the user's Tailnet.
 * Optionally probes each online node for a running `computerd` daemon.
 */
export async function discoverTailscalePeers(
  options: TailscaleDiscoverOptions = {},
): Promise<TailscalePeerInfo[]> {
  const exec = options.execCommand ?? defaultExecCommand;
  const bin = options.tailscaleBin ?? "tailscale";
  const rawJson = await exec(bin, ["status", "--json"]);
  const parsed = JSON.parse(rawJson) as RawTailscaleStatus;

  const peers: TailscalePeerInfo[] = [];
  if (options.includeSelf !== false && parsed.Self) {
    peers.push(normalizeNode(parsed.Self, true));
  }
  if (parsed.Peer && typeof parsed.Peer === "object") {
    for (const node of Object.values(parsed.Peer)) {
      const info = normalizeNode(node, false);
      if (options.includeOffline || info.online) {
        peers.push(info);
      }
    }
  }

  if (options.probeComputerdPort !== undefined) {
    const port = options.probeComputerdPort;
    const noVncPort = options.noVncPort ?? 6080;
    const timeoutMs = options.probeTimeoutMs ?? 1_500;
    await Promise.all(
      peers.map(async (peer) => {
        if (!peer.online) return;
        const addr = formatHostForUrl(pickPeerAddress(peer, false));
        const url = `http://${addr}:${port}`;
        const noVncUrl = `http://${addr}:${noVncPort}/vnc.html?autoconnect=true&resize=scale`;
        const reachable = await probeHealthEndpoint(url, timeoutMs);
        peer.computerd = { reachable, url, noVncUrl };
      }),
    );
  }

  return peers;
}

/**
 * Resolves a Tailscale peer specification (hostname, MagicDNS name, IP, or URL)
 * into a concrete `{ url, noVncUrl, host, peer }` target.
 */
export async function resolveTailscaleTarget(
  options: TailscaleComputerdBackendOptions = {},
): Promise<{
  url: string;
  noVncUrl: string;
  host: string;
  peer?: TailscalePeerInfo;
}> {
  const port = options.port ?? 8080;
  const noVncPort = options.noVncPort ?? 6080;
  const protocol = options.protocol ?? "http";
  const rawTarget = options.peer?.trim();

  // 1. If a full http:// or https:// URL was given, use it directly.
  if (rawTarget && /^https?:\/\//i.test(rawTarget)) {
    const parsedUrl = new URL(rawTarget);
    const host = parsedUrl.hostname;
    const url = rawTarget.replace(/\/+$/, "");
    const noVncUrl = `${parsedUrl.protocol}//${formatHostForUrl(host)}:${noVncPort}/vnc.html?autoconnect=true&resize=scale`;
    return { url, noVncUrl, host };
  }

  // 2. If an explicit IPv4 (e.g. 100.x.y.z), IPv6, or *.ts.net FQDN with port or dots was given,
  // try resolving against `tailscale status --json` first to enrich metadata, but fall back
  // directly to the literal address even if the local `tailscale` CLI is not in PATH.
  const looksLikeLiteralAddress =
    rawTarget !== undefined &&
    (/^\d{1,3}(\.\d{1,3}){3}(:\d+)?$/.test(rawTarget) ||
      rawTarget.includes(".ts.net") ||
      rawTarget.includes(":"));

  try {
    const peers = await discoverTailscalePeers({
      tailscaleBin: options.tailscaleBin,
      includeOffline: true,
      includeSelf: true,
      execCommand: options.execCommand,
      ...(rawTarget === undefined ? { probeComputerdPort: port, noVncPort } : {}),
    });

    if (rawTarget === undefined) {
      const active = peers.find((p) => p.computerd?.reachable);
      if (!active) {
        throw new Error(
          `No reachable computerd instance found on port ${port} across ${peers.length} Tailscale peers.`,
        );
      }
      const host = pickPeerAddress(active, options.preferMagicDns);
      const formatted = formatHostForUrl(host);
      return {
        url: `${protocol}://${formatted}:${port}`,
        noVncUrl: `${protocol}://${formatted}:${noVncPort}/vnc.html?autoconnect=true&resize=scale`,
        host,
        peer: active,
      };
    }

    const cleanTarget = rawTarget.replace(/:\d+$/, "").replace(/\.$/, "").toLowerCase();
    const matched = peers.find(
      (p) =>
        p.hostName.toLowerCase() === cleanTarget ||
        p.dnsName.toLowerCase() === cleanTarget ||
        p.dnsName.toLowerCase().startsWith(`${cleanTarget}.`) ||
        p.tailscaleIps.some((ip) => ip.toLowerCase() === cleanTarget),
    );

    if (matched) {
      const host = pickPeerAddress(matched, options.preferMagicDns);
      const formatted = formatHostForUrl(host);
      return {
        url: `${protocol}://${formatted}:${port}`,
        noVncUrl: `${protocol}://${formatted}:${noVncPort}/vnc.html?autoconnect=true&resize=scale`,
        host,
        peer: matched,
      };
    }
  } catch (err) {
    if (!looksLikeLiteralAddress) {
      throw err;
    }
  }

  if (!rawTarget) {
    throw new Error("Tailscale peer hostname, MagicDNS name, or IP is required.");
  }

  // Extract optional `:port` suffix from `host:port`
  const hostPortMatch = /^([^:]+):(\d+)$/.exec(rawTarget);
  const host = hostPortMatch ? hostPortMatch[1] : rawTarget;
  const effectivePort = hostPortMatch ? Number.parseInt(hostPortMatch[2], 10) : port;
  const formatted = formatHostForUrl(host);

  return {
    url: `${protocol}://${formatted}:${effectivePort}`,
    noVncUrl: `${protocol}://${formatted}:${noVncPort}/vnc.html?autoconnect=true&resize=scale`,
    host,
  };
}

/**
 * WorkspaceBackend that connects to a remote or virtual-LAN `computerd`
 * instance over Tailscale.
 */
export class TailscaleComputerdBackend implements WorkspaceBackend {
  readonly id: string;
  readonly type = "tailscale";
  readonly description?: string;
  readonly #options: TailscaleComputerdBackendOptions;
  #resolvedUrl?: string;
  #resolvedNoVncUrl?: string;
  #resolvedPeer?: TailscalePeerInfo;

  constructor(options: TailscaleComputerdBackendOptions = {}) {
    this.id = options.id ?? "tailscale";
    this.#options = options;
    if (options.description !== undefined) {
      this.description = options.description;
    }
  }

  /** Returns the resolved `computerd` base URL after `connect()`. */
  get url(): string | undefined {
    return this.#resolvedUrl;
  }

  /** Returns the resolved `noVNC` browser desktop URL after `connect()`. */
  get noVncUrl(): string | undefined {
    return this.#resolvedNoVncUrl;
  }

  /** Returns the matched Tailscale peer metadata if discovered via `tailscale status`. */
  get peerInfo(): TailscalePeerInfo | undefined {
    return this.#resolvedPeer;
  }

  async connect(): Promise<BackendHandle> {
    const resolved = await resolveTailscaleTarget(this.#options);
    this.#resolvedUrl = resolved.url;
    this.#resolvedNoVncUrl = resolved.noVncUrl;
    this.#resolvedPeer = resolved.peer;

    if (this.#options.probeHealth ?? true) {
      await waitForComputerd(
        resolved.url,
        this.#options.secret,
        this.#options.readyTimeoutMs ?? 15_000,
      );
    }

    const inner = new ComputerdBackend({
      id: this.id,
      url: resolved.url,
      secret: this.#options.secret,
      probeHealth: false,
      description: this.description,
    });
    return await inner.connect();
  }
}
