// Startup resolution of the local-only path configuration. Kept apart
// from ignore.ts so the matcher stays a pure function of its inputs.
//
// Fails closed: a misconfiguration that silently disabled the feature
// would send a full node_modules into the Durable Object, the exact
// failure #179 is about, so the daemon refuses to mount instead.

import { isAbsolute, join, resolve } from "node:path";

import {
  MountIgnorePathError,
  type MountIgnoreSet,
  parseMountIgnore,
  resolveMountIgnore,
} from "./ignore.js";

export interface MountIgnoreConfig {
  /** Where local-only paths are stored. Absolute, outside the mount. */
  readonly root: string;
  /** The resolved set. Empty when the feature is off. */
  readonly ignore: MountIgnoreSet;
  /** True when at least one path is configured. */
  readonly enabled: boolean;
  /** Local-only directories to bind-mount from `root` (MOUNT_NATIVE). */
  readonly native: NativeRootsConfig;
}

export interface NativeRootsConfig {
  /** Normalized MOUNT_NATIVE patterns, in the order written. */
  readonly patterns: readonly string[];
  /** True when at least one pattern is configured. */
  readonly enabled: boolean;
  /** Whether a mount-relative path is one a MOUNT_NATIVE pattern names. */
  readonly matches: (relativePath: string) => boolean;
}

export interface MountIgnoreEnv {
  MOUNT_IGNORE?: string;
  MOUNT_IGNORE_PATH?: string;
  MOUNT_NATIVE?: string;
}

export class MountNativeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MountNativeError";
  }
}

/**
 * Default root: /tmp + the mount point. Under /tmp rather than a tmpfs
 * so a container snapshot captures it -- that is the only durability
 * local-only content has, being deliberately absent from sync.
 */
export function defaultIgnoreRoot(mountPoint: string): string {
  return join("/tmp", mountPoint);
}

export function resolveMountIgnoreConfig(
  env: MountIgnoreEnv,
  mountPoint: string,
): MountIgnoreConfig {
  const entries = parseMountIgnore(env.MOUNT_IGNORE);
  const ignore = resolveMountIgnore(entries, mountPoint);

  const configuredRoot = env.MOUNT_IGNORE_PATH?.trim();
  const root =
    configuredRoot === undefined || configuredRoot === ""
      ? defaultIgnoreRoot(mountPoint)
      : configuredRoot;

  if (!isAbsolute(root)) {
    throw new Error(`MOUNT_IGNORE_PATH must be an absolute path, got ${JSON.stringify(root)}`);
  }

  const normalizedRoot = resolve(root).replace(/\/+$/, "") || "/";
  const normalizedMount = resolve(mountPoint).replace(/\/+$/, "") || "/";

  // A root under the mount would make the passthrough layer resolve into
  // itself: every write to an ignored path would land at a location that
  // is also an ignored path, one level deeper, forever.
  if (normalizedRoot === normalizedMount || normalizedRoot.startsWith(`${normalizedMount}/`)) {
    throw new Error(
      `MOUNT_IGNORE_PATH (${normalizedRoot}) must not be inside MOUNT_POINT ` +
        `(${normalizedMount}); local-only paths are stored outside the mount.`,
    );
  }

  if (normalizedRoot === "/") {
    throw new Error("MOUNT_IGNORE_PATH must not be the filesystem root");
  }

  const native = resolveNativeRoots(env.MOUNT_NATIVE, ignore, mountPoint);
  return { root: normalizedRoot, ignore, enabled: !ignore.isEmpty, native };
}

/**
 * MOUNT_NATIVE names a subset of MOUNT_IGNORE. Each entry must be written
 * as one of the MOUNT_IGNORE inclusions (after the same normalization),
 * so a native root is always a path that is already local-only and the
 * bind mount changes how it is served, never whether it is synced.
 */
export function resolveNativeRoots(
  raw: string | undefined,
  ignore: MountIgnoreSet,
  mountPoint: string,
): NativeRootsConfig {
  const entries = parseMountIgnore(raw);
  const patterns: string[] = [];
  for (const entry of entries) {
    if (entry.startsWith("!")) {
      throw new MountNativeError(
        `MOUNT_NATIVE pattern ${JSON.stringify(entry)} is an exclusion. MOUNT_NATIVE lists ` +
          `local-only directories to mount; keep exclusions in MOUNT_IGNORE.`,
      );
    }
    let normalized: string;
    try {
      normalized = resolveMountIgnore([entry], mountPoint).patterns[0] as string;
    } catch (error) {
      if (error instanceof MountIgnorePathError) {
        throw new MountNativeError(error.message.replace(/^MOUNT_IGNORE/, "MOUNT_NATIVE"));
      }
      throw error;
    }
    if (!ignore.patterns.includes(normalized)) {
      throw new MountNativeError(
        `MOUNT_NATIVE pattern ${JSON.stringify(entry)} is not in MOUNT_IGNORE. Only ` +
          `local-only paths can be mounted natively; add ${JSON.stringify(normalized)} ` +
          `to MOUNT_IGNORE as well.`,
      );
    }
    patterns.push(normalized);
  }
  const set = resolveMountIgnore(patterns, "/");
  return { patterns, enabled: patterns.length > 0, matches: set.matches };
}

export interface PassthroughStatus {
  /** Local-only paths exist and COMPUTERD_FUSE_PASSTHROUGH did not turn it off. */
  readonly requested: boolean;
  readonly negotiated: boolean;
  readonly opens: number;
  readonly fallbacks: number;
}

/** The `ignore` block reported on /__computerd/info. */
export interface MountIgnoreInfo {
  readonly supported: true;
  readonly enabled: boolean;
  readonly root: string;
  // Patterns, not paths: "**/node_modules" can't be joined onto the
  // mount point.
  readonly patterns: readonly string[];
  readonly ineffectiveExclusions: readonly string[];
  readonly fastPaths: {
    readonly passthrough: boolean;
    readonly passthroughReason: string;
    readonly passthroughOpens: number;
    readonly passthroughFallbacks: number;
    /** Possible under libfuse 3, but it would change writes on the synced mount. */
    readonly writebackCache: false;
    readonly nativeRoots: NativeRootsInfo;
  };
}

/** Counters from the native-roots module, as `describeMountIgnore` reads them. */
export interface NativeRootsCounters {
  readonly active: number;
  readonly mounts: number;
  readonly failures: number;
  readonly detaches: number;
  readonly lastFailure: string | undefined;
}

export interface NativeRootsInfo {
  /** True when native roots are being mounted. */
  readonly enabled: boolean;
  readonly reason: string;
  readonly patterns: readonly string[];
  readonly active: number;
  readonly mounts: number;
  readonly failures: number;
  readonly detaches: number;
}

/** `status` is undefined when no kernel FUSE mount is running. */
export function describeMountIgnore(
  config: MountIgnoreConfig,
  status?: PassthroughStatus,
  native?: NativeRootsCounters,
): MountIgnoreInfo {
  const inactive = inactivePassthroughReason(config, status);
  const nativeInactive = inactiveNativeRootsReason(config, status);
  return {
    supported: true,
    enabled: config.enabled,
    root: config.root,
    patterns: config.ignore.patterns,
    ineffectiveExclusions: config.ignore.ineffectiveExclusions,
    fastPaths: {
      passthrough: inactive === undefined,
      passthroughReason: inactive ?? activeReason(status?.fallbacks ?? 0),
      passthroughOpens: status?.opens ?? 0,
      passthroughFallbacks: status?.fallbacks ?? 0,
      writebackCache: false,
      nativeRoots: {
        enabled: nativeInactive === undefined,
        reason: nativeInactive ?? nativeActiveReason(native),
        patterns: config.native.patterns,
        active: native?.active ?? 0,
        mounts: native?.mounts ?? 0,
        failures: native?.failures ?? 0,
        detaches: native?.detaches ?? 0,
      },
    },
  };
}

// Native roots ride on passthrough: both need CAP_SYS_ADMIN and a 6.9
// kernel, and without passthrough a file opened through FUSE before its
// root was mounted would have a page cache of its own.
function inactiveNativeRootsReason(
  config: MountIgnoreConfig,
  status: PassthroughStatus | undefined,
): string | undefined {
  if (!config.native.enabled) return "no native roots are configured (MOUNT_NATIVE)";
  if (status === undefined) return "no kernel FUSE mount is running";
  if (!status.requested) {
    return "FUSE passthrough is turned off with COMPUTERD_FUSE_PASSTHROUGH, and native roots need it";
  }
  if (!status.negotiated) {
    return "the kernel did not offer FUSE passthrough, and native roots need it (Linux 6.9 or newer)";
  }
  return undefined;
}

function nativeActiveReason(native: NativeRootsCounters | undefined): string {
  if (native === undefined || native.failures === 0) return "active";
  if (native.mounts === 0) {
    return (
      `active, but every mount so far was refused (${native.failures}; last: ` +
      `${native.lastFailure ?? "unknown"}); check that computerd has CAP_SYS_ADMIN and ` +
      `that util-linux mount is installed`
    );
  }
  return `active; ${native.failures} mount(s) failed and those paths are served through FUSE`;
}

// Each case has a different fix, so each gets its own wording.
function inactivePassthroughReason(
  config: MountIgnoreConfig,
  status: PassthroughStatus | undefined,
): string | undefined {
  if (!config.enabled) return "no local-only paths are configured (MOUNT_IGNORE)";
  if (status === undefined) {
    return "no kernel FUSE mount is running, so local-only paths are not passed through";
  }
  if (!status.requested) return "turned off with COMPUTERD_FUSE_PASSTHROUGH";
  if (!status.negotiated) {
    return "the kernel did not offer FUSE passthrough at init; it needs Linux 6.9 or newer";
  }
  if (status.opens > 0) return undefined;
  if (status.fallbacks > 0) {
    return (
      `the kernel offered passthrough but refused every backing registration ` +
      `(${status.fallbacks}); check that computerd has CAP_SYS_ADMIN and that ` +
      `MOUNT_IGNORE_PATH is not on overlayfs stacked on another overlayfs`
    );
  }
  return "negotiated, but no local-only file has been opened yet";
}

function activeReason(fallbacks: number): string {
  return fallbacks === 0
    ? "active"
    : `active; ${fallbacks} open(s) fell back to computerd after a refused registration`;
}
