// Native roots: bind-mounts local-only directories onto the mount. See
// packages/computerd/README.md#native-roots-mount_native.
//
// The local-only layer in passthrough.ts already stores each local-only
// path at MOUNT_IGNORE_PATH/<rel> and serves it through FUSE. A native
// root bind-mounts that same directory at MOUNT_POINT/<rel>, so lookups,
// stats, creates, and listings under it stop reaching this process. The
// source is the directory the FUSE layer serves anyway, which is what
// keeps this simple:
//
// - A mount that lands late, fails, or is detached changes how a path is
//   served, never what it contains. Nothing here is on a correctness
//   path, so every failure is "leave it to the FUSE layer".
// - /proc/self/mountinfo is the only state. Anything mounted strictly
//   under MOUNT_POINT was mounted by this module, so there is no registry
//   to write, recover, or get out of step.
// - A lazy detach is always safe: the detached tree is the same backing
//   directory the FUSE layer serves, and it is never synced.
// - Renaming a synced directory needs nothing: the kernel moves a mount
//   along with the dentry it sits on. (Re-mounting from the rename reply
//   would race the kernel's own move and stack a second mount.)
//
// One rule is load-bearing: no synchronous filesystem call on the main
// thread may touch a path under MOUNT_POINT. Resolving such a path sends
// FUSE requests that this same thread has to answer, so a synchronous
// call there deadlocks the daemon. Paths under the backing root and
// /proc are fine. mount and umount run as child processes, and the one
// stat of a mounted target goes through the libuv thread pool.

import { spawn } from "node:child_process";
import { lstatSync, readdirSync, readFileSync, promises as fsPromises } from "node:fs";
import { dirname, join } from "node:path";

import type { MountIgnoreSet } from "./ignore.js";

export interface NativeRootsOptions {
  /** Resolved MOUNT_IGNORE_PATH: where local-only paths are stored. */
  readonly root: string;
  /** The FUSE mount point. */
  readonly mountPoint: string;
  /** The decided ignore set. */
  readonly ignore: MountIgnoreSet;
  /** Whether a mount-relative path is named by a MOUNT_NATIVE pattern. */
  readonly native: (relativePath: string) => boolean;
  /**
   * Checked on every `ensure`. Lets the daemon build this before the
   * FUSE mount exists and switch it on once passthrough is negotiated.
   */
  readonly active?: () => boolean;
  /** Injected for tests. Each seam defaults to the real system. */
  readonly run?: (argv: readonly string[]) => Promise<number>;
  readonly mountinfo?: () => string;
  readonly lstat?: (path: string) => { isDirectory(): boolean; dev: number; ino: number };
  readonly stat?: (path: string) => Promise<{ dev: number; ino: number }>;
  /** Asynchronous lstat of a path under the mount point. */
  readonly lstatTarget?: (path: string) => Promise<{ isDirectory(): boolean }>;
  readonly readdir?: (path: string) => string[];
  readonly warn?: (message: string) => void;
}

export interface NativeRootsStats {
  /** Native roots mounted right now, read from mountinfo. */
  readonly active: number;
  /** Mounts that succeeded since start. */
  readonly mounts: number;
  /** Mounts that were refused or failed verification. */
  readonly failures: number;
  /** Lazy detaches issued since start. */
  readonly detaches: number;
  /** The most recent failure, for the info endpoint. */
  readonly lastFailure: string | undefined;
}

export interface NativeRoots {
  /**
   * Mount `rel` if it is a native root. Fire-and-forget; never throws.
   * `created` says the directory was just made. A lookup (`created`
   * false) skips a parked root: one whose mount was refused, or one a
   * caller detached so it could remove it. Creating it again unparks it.
   */
  ensure(relativePath: string, created?: boolean): void;
  /** Ensure every native root that already exists on the backing disk. */
  scan(): void;
  /** Resolves once every mount started so far has settled. For tests. */
  settled(): Promise<void>;
  /**
   * Lazily detach one native root, or all of them, on a caller's request,
   * and park them so a lookup does not mount them straight back while the
   * caller removes or renames them. Never throws.
   */
  detach(relativePath?: string): Promise<string[]>;
  /** Lazily detach everything, at startup and shutdown. Parks nothing. */
  detachAll(): Promise<string[]>;
  /** Whether `rel` is a native root: the topmost local-only directory named by MOUNT_NATIVE. */
  isRoot(relativePath: string): boolean;
  stats(): NativeRootsStats;
}

export function createNativeRoots(options: NativeRootsOptions): NativeRoots {
  const root = trimTrailing(options.root);
  const mountPoint = trimTrailing(options.mountPoint) || "/";
  const run = options.run ?? runCommand;
  const readMountinfo = options.mountinfo ?? (() => readFileSync("/proc/self/mountinfo", "utf8"));
  const lstat = options.lstat ?? ((path: string) => lstatSync(path));
  const stat = options.stat ?? ((path: string) => fsPromises.stat(path));
  const lstatTarget = options.lstatTarget ?? ((path: string) => fsPromises.lstat(path));
  const readdir = options.readdir ?? ((path: string) => readdirSync(path));
  const warn = options.warn ?? ((message: string) => console.warn(message));
  const active = options.active ?? (() => true);

  const inflight = new Map<string, Promise<void>>();
  // Roots a lookup must not mount: refused ones, and ones a caller
  // detached on purpose. Creating the directory again unparks it.
  const parked = new Set<string>();
  let mounts = 0;
  let failures = 0;
  let detaches = 0;
  let lastFailure: string | undefined;

  const targetOf = (rel: string): string => join(mountPoint, rel);
  const relOf = (target: string): string => stripSlashes(target.slice(mountPoint.length));
  const sourceOf = (rel: string): string => join(root, rel);

  const isRoot = (relativePath: string): boolean => {
    const rel = stripSlashes(relativePath);
    if (rel === "") return false;
    return (
      options.ignore.ignores(rel) && !options.ignore.ignores(parentOf(rel)) && options.native(rel)
    );
  };

  // Everything strictly under the mount point. The FUSE mount itself sits
  // at the mount point and is excluded.
  const owned = (): string[] => {
    let text: string;
    try {
      text = readMountinfo();
    } catch {
      return [];
    }
    const prefix = mountPoint === "/" ? "/" : `${mountPoint}/`;
    const targets: string[] = [];
    for (const line of text.split("\n")) {
      const field = line.split(" ")[4];
      if (field === undefined) continue;
      const target = unescapeMountinfo(field);
      if (target !== mountPoint && target.startsWith(prefix)) targets.push(target);
    }
    return targets;
  };

  const recordFailure = (rel: string, reason: string): void => {
    failures += 1;
    parked.add(rel);
    lastFailure = `${rel}: ${reason}`;
    // Once per process. A refused mount is refused for every root, and a
    // line per root would bury the log during an install.
    if (failures === 1) {
      warn(
        `computerd: could not mount native root ${rel} (${reason}); serving it through ` +
          `FUSE instead, which works but is slower. Further failures are counted in ` +
          `/__computerd/stats under localPaths.nativeRoots.`,
      );
    }
  };

  const stillThere = async (source: string, target: string): Promise<boolean> => {
    try {
      lstat(source);
      return (await lstatTarget(target)).isDirectory();
    } catch {
      return false;
    }
  };

  async function mountOne(rel: string): Promise<void> {
    const source = sourceOf(rel);
    const target = targetOf(rel);
    let sourceStat: { isDirectory(): boolean; dev: number; ino: number };
    try {
      // lstat, so a symlink at the root path is never mounted over.
      sourceStat = lstat(source);
    } catch {
      return; // Removed again before we got here.
    }
    if (!sourceStat.isDirectory()) return;
    if (owned().includes(target)) return;
    // The synced parent may not exist yet: after a restore with an
    // in-memory store, the host pushes it back later. That is "not yet",
    // not a failure; the first lookup after it arrives mounts the root.
    // Asynchronous, because the target is under the mount.
    try {
      if (!(await lstatTarget(target)).isDirectory()) return;
    } catch {
      return;
    }

    const bound = await run(["mount", "--bind", source, target]);
    if (bound !== 0) {
      // Removed while the mount was on its way, as `rm -rf` does right
      // after a lookup. Gone is not refused.
      if (!(await stillThere(source, target))) return;
      recordFailure(rel, `mount --bind exited ${bound}`);
      return;
    }
    // Keep the mount out of any shared peer group the container runtime
    // set up, so it never propagates beyond this namespace.
    await run(["mount", "--make-private", target]);

    try {
      const mounted = await stat(target);
      if (mounted.dev !== sourceStat.dev || mounted.ino !== sourceStat.ino) {
        await run(["umount", "-l", target]);
        recordFailure(rel, "the mounted directory is not the backing directory");
        return;
      }
    } catch (error) {
      await run(["umount", "-l", target]);
      recordFailure(rel, `could not verify the mount: ${String(error)}`);
      return;
    }
    mounts += 1;
  }

  const ensure = (relativePath: string, created = false): void => {
    if (!active()) return;
    const rel = stripSlashes(relativePath);
    if (!isRoot(rel) || inflight.has(rel)) return;
    if (parked.has(rel)) {
      if (!created) return;
      parked.delete(rel);
    }
    const pending = mountOne(rel)
      .catch((error: unknown) => recordFailure(rel, String(error)))
      .finally(() => inflight.delete(rel));
    inflight.set(rel, pending);
  };

  // Walks the backing tree: synced ancestors of local paths exist there as
  // plain directories. Never descends into a local-only directory, so the
  // cost is the scaffolding, not the dependency tree.
  const walk = (relativePath: string, visit: (rel: string) => void): void => {
    const rel = stripSlashes(relativePath);
    let names: string[];
    try {
      names = readdir(rel === "" ? root : sourceOf(rel));
    } catch {
      return;
    }
    for (const name of names) {
      const child = rel === "" ? name : `${rel}/${name}`;
      if (isRoot(child)) {
        visit(child);
      } else if (!options.ignore.ignores(child)) {
        walk(child, visit);
      }
    }
  };

  const detachTargets = async (targets: string[]): Promise<string[]> => {
    const detached: string[] = [];
    // Deepest first, so a parent is never detached out from under a child.
    for (const target of [...targets].sort((a, b) => b.length - a.length)) {
      if ((await run(["umount", "-l", target])) === 0) {
        detaches += 1;
        detached.push(target);
      }
    }
    return detached;
  };

  return {
    ensure,
    scan: () => {
      if (active()) walk("", (rel) => ensure(rel));
    },
    settled: async () => {
      while (inflight.size > 0) await Promise.all([...inflight.values()]);
    },
    detach: async (relativePath) => {
      const all = owned();
      const targets =
        relativePath === undefined
          ? all
          : all.filter((candidate) => candidate === targetOf(stripSlashes(relativePath)));
      const detached = await detachTargets(targets);
      for (const target of detached) parked.add(relOf(target));
      return detached;
    },
    detachAll: () => detachTargets(owned()),
    isRoot,
    stats: () => ({ active: owned().length, mounts, failures, detaches, lastFailure }),
  };
}

/** mountinfo escapes space, tab, newline, and backslash as octal. */
export function unescapeMountinfo(field: string): string {
  return field.replace(/\\([0-7]{3})/g, (_, octal: string) =>
    String.fromCharCode(Number.parseInt(octal, 8)),
  );
}

function runCommand(argv: readonly string[]): Promise<number> {
  return new Promise((resolve) => {
    const [command, ...args] = argv;
    if (command === undefined) {
      resolve(127);
      return;
    }
    const child = spawn(command, args, { stdio: "ignore" });
    child.once("error", () => resolve(127));
    child.once("exit", (code) => resolve(code ?? 1));
  });
}

function parentOf(rel: string): string {
  const parent = dirname(rel);
  return parent === "." ? "" : parent;
}

function stripSlashes(value: string): string {
  let out = value;
  while (out.startsWith("/")) out = out.slice(1);
  while (out.endsWith("/")) out = out.slice(0, -1);
  return out;
}

function trimTrailing(value: string): string {
  return value.replace(/\/+$/, "");
}
