import { describe, expect, test } from "vitest";

import { resolveMountIgnore } from "./ignore.js";
import { createNativeRoots, type NativeRootsOptions, unescapeMountinfo } from "./native-roots.js";

const ROOT = "/tmp/workspace";
const MOUNT = "/workspace";

interface Harness {
  roots: ReturnType<typeof createNativeRoots>;
  commands: string[][];
  mounted: Set<string>;
  warnings: string[];
}

/**
 * A fake system: `dirs` is the backing tree (paths relative to ROOT),
 * `mount --bind` adds the target to the fake mount table, and the mounted
 * target stats as its source unless `mismatch` is set.
 */
function harness(
  options: {
    ignore?: string[];
    native?: string[];
    dirs?: string[];
    files?: string[];
    symlinks?: string[];
    mountExit?: number;
    mismatch?: boolean;
    active?: () => boolean;
    /** Mount-relative targets that do not exist under the mount yet. */
    missingTargets?: Set<string>;
  } = {},
): Harness {
  const ignore = resolveMountIgnore(options.ignore ?? ["**/node_modules", "/dist"], MOUNT);
  const native = resolveMountIgnore(options.native ?? ["**/node_modules"], "/");
  const dirs = new Set(options.dirs ?? []);
  const files = new Set(options.files ?? []);
  const symlinks = new Set(options.symlinks ?? []);
  const commands: string[][] = [];
  const mounted = new Set<string>();
  const warnings: string[] = [];
  const rel = (path: string) => path.slice(ROOT.length + 1);
  const inode = (path: string) => path.length;

  const seams: Partial<NativeRootsOptions> = {
    run: async (argv) => {
      commands.push([...argv]);
      if (argv[0] === "mount" && argv[1] === "--bind") {
        if ((options.mountExit ?? 0) !== 0) return options.mountExit as number;
        mounted.add(argv[3] as string);
      }
      if (argv[0] === "umount") mounted.delete(argv[2] as string);
      return 0;
    },
    mountinfo: () =>
      [
        `22 1 0:40 / ${MOUNT} rw - fuse computerd rw`,
        ...[...mounted].map((target, i) => `${30 + i} 22 254:1 /x ${target} rw - ext4 /dev/vda rw`),
      ].join("\n"),
    lstat: (path) => {
      const key = rel(path);
      if (symlinks.has(key)) return { isDirectory: () => false, dev: 1, ino: inode(path) };
      const isDir = [...dirs, ...files].some((entry) => entry.startsWith(`${key}/`));
      if (dirs.has(key) || isDir) return { isDirectory: () => true, dev: 1, ino: inode(path) };
      if (files.has(key)) return { isDirectory: () => false, dev: 1, ino: inode(path) };
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    },
    lstatTarget: async (path) => {
      if (options.missingTargets?.has(path.slice(MOUNT.length + 1))) {
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      }
      return { isDirectory: () => true };
    },
    stat: async (path) => {
      const source = `${ROOT}${path.slice(MOUNT.length)}`;
      return { dev: 1, ino: options.mismatch ? 0 : inode(source) };
    },
    readdir: (path) => {
      const prefix = path === ROOT ? "" : `${rel(path)}/`;
      const names = new Set<string>();
      for (const entry of [...dirs, ...files, ...symlinks]) {
        if (!entry.startsWith(prefix)) continue;
        const rest = entry.slice(prefix.length);
        if (rest === "") continue;
        names.add(rest.split("/")[0] as string);
      }
      return [...names];
    },
    warn: (message) => warnings.push(message),
  };

  const roots = createNativeRoots({
    root: ROOT,
    mountPoint: MOUNT,
    ignore,
    native: native.matches,
    ...(options.active ? { active: options.active } : {}),
    ...seams,
  });
  return { roots, commands, mounted, warnings };
}

describe("isRoot", () => {
  test("is the topmost local-only directory a MOUNT_NATIVE pattern names", () => {
    const { roots } = harness();
    expect(roots.isRoot("node_modules")).toBe(true);
    expect(roots.isRoot("packages/app/node_modules")).toBe(true);
    expect(roots.isRoot("/packages/app/node_modules/")).toBe(true);
  });

  test("is false below a root, for synced paths, and for the mount root", () => {
    const { roots } = harness();
    expect(roots.isRoot("node_modules/react")).toBe(false);
    expect(roots.isRoot("node_modules/react/node_modules")).toBe(false);
    expect(roots.isRoot("src")).toBe(false);
    expect(roots.isRoot("")).toBe(false);
  });

  test("is false for a local-only path that MOUNT_NATIVE does not name", () => {
    const { roots } = harness();
    expect(roots.isRoot("dist")).toBe(false);
  });

  test("respects an exclusion that keeps a path synced", () => {
    const { roots } = harness({ ignore: ["**/node_modules", "!/vendor/node_modules"] });
    expect(roots.isRoot("vendor/node_modules")).toBe(false);
    expect(roots.isRoot("vendor/node_modules/pkg/node_modules")).toBe(true);
  });
});

describe("ensure", () => {
  test("bind-mounts the backing directory, makes it private, and verifies it", async () => {
    const { roots, commands, mounted } = harness({ dirs: ["app/node_modules"] });
    roots.ensure("app/node_modules");
    await roots.settled();
    expect(commands).toEqual([
      ["mount", "--bind", `${ROOT}/app/node_modules`, `${MOUNT}/app/node_modules`],
      ["mount", "--make-private", `${MOUNT}/app/node_modules`],
    ]);
    expect([...mounted]).toEqual([`${MOUNT}/app/node_modules`]);
    expect(roots.stats()).toMatchObject({ active: 1, mounts: 1, failures: 0 });
  });

  test("ignores paths that are not native roots", async () => {
    const { roots, commands } = harness({ dirs: ["src", "dist", "node_modules/react"] });
    for (const path of ["src", "dist", "node_modules/react"]) roots.ensure(path);
    await roots.settled();
    expect(commands).toEqual([]);
  });

  test("never mounts over a symlink or a file", async () => {
    const { roots, commands } = harness({
      symlinks: ["a/node_modules"],
      files: ["b/node_modules"],
    });
    roots.ensure("a/node_modules");
    roots.ensure("b/node_modules");
    await roots.settled();
    expect(commands).toEqual([]);
  });

  test("does nothing when the backing directory is already gone", async () => {
    const { roots, commands, warnings } = harness();
    roots.ensure("node_modules");
    await roots.settled();
    expect(commands).toEqual([]);
    expect(warnings).toEqual([]);
  });

  test("concurrent calls for one root mount once", async () => {
    const { roots, commands } = harness({ dirs: ["node_modules"] });
    roots.ensure("node_modules");
    roots.ensure("node_modules");
    roots.ensure("/node_modules/");
    await roots.settled();
    expect(commands.filter((argv) => argv[1] === "--bind")).toHaveLength(1);
  });

  test("an already mounted root is left alone", async () => {
    const { roots, commands } = harness({ dirs: ["node_modules"] });
    roots.ensure("node_modules");
    await roots.settled();
    roots.ensure("node_modules");
    await roots.settled();
    expect(commands.filter((argv) => argv[1] === "--bind")).toHaveLength(1);
  });

  test("a refused mount is counted and warned about once", async () => {
    const { roots, warnings } = harness({
      dirs: ["a/node_modules", "b/node_modules"],
      mountExit: 32,
    });
    roots.ensure("a/node_modules");
    roots.ensure("b/node_modules");
    await roots.settled();
    expect(roots.stats()).toMatchObject({ active: 0, mounts: 0, failures: 2 });
    expect(roots.stats().lastFailure).toContain("exited 32");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("serving it through FUSE instead");
  });

  test("a refused root is retried when created again, not when looked up", async () => {
    const h = harness({ dirs: ["node_modules"], mountExit: 32 });
    h.roots.ensure("node_modules", true);
    await h.roots.settled();
    h.roots.ensure("node_modules");
    h.roots.ensure("node_modules", false);
    await h.roots.settled();
    const binds = () => h.commands.filter((argv) => argv[1] === "--bind").length;
    expect(binds()).toBe(1);
    h.roots.ensure("node_modules", true);
    await h.roots.settled();
    expect(binds()).toBe(2);
  });

  test("a target that does not exist under the mount yet is not a failure", async () => {
    // After a restore with an in-memory store the backing directory is on
    // disk, but its synced parent is not back from the host yet.
    const missingTargets = new Set(["app/node_modules"]);
    const { roots, commands, warnings } = harness({ dirs: ["app/node_modules"], missingTargets });
    roots.ensure("app/node_modules");
    await roots.settled();
    expect(commands).toEqual([]);
    expect(roots.stats().failures).toBe(0);
    expect(warnings).toEqual([]);
    // The first lookup once the parent is back mounts it.
    missingTargets.clear();
    roots.ensure("app/node_modules");
    await roots.settled();
    expect(roots.stats()).toMatchObject({ active: 1, mounts: 1 });
  });

  test("a mount that does not show the backing directory is detached", async () => {
    const { roots, commands, mounted } = harness({ dirs: ["node_modules"], mismatch: true });
    roots.ensure("node_modules");
    await roots.settled();
    expect(commands.at(-1)).toEqual(["umount", "-l", `${MOUNT}/node_modules`]);
    expect(mounted.size).toBe(0);
    expect(roots.stats()).toMatchObject({ mounts: 0, failures: 1 });
  });

  test("does nothing until switched on", async () => {
    let on = false;
    const { roots, commands } = harness({ dirs: ["node_modules"], active: () => on });
    roots.ensure("node_modules");
    roots.scan();
    await roots.settled();
    expect(commands).toEqual([]);
    on = true;
    roots.ensure("node_modules");
    await roots.settled();
    expect(commands).toHaveLength(2);
  });
});

describe("scan", () => {
  test("scan mounts every existing root without descending into one", async () => {
    const readdirs: string[] = [];
    const h = harness({
      dirs: [
        "node_modules/react/node_modules/x",
        "packages/a/node_modules/lodash",
        "packages/b/src",
        "dist/assets",
      ],
    });
    const roots = createNativeRoots({
      root: ROOT,
      mountPoint: MOUNT,
      ignore: resolveMountIgnore(["**/node_modules", "/dist"], MOUNT),
      native: resolveMountIgnore(["**/node_modules"], "/").matches,
      run: async (argv) => {
        h.commands.push([...argv]);
        return 0;
      },
      mountinfo: () => "",
      lstat: () => ({ isDirectory: () => true, dev: 1, ino: 1 }),
      stat: async () => ({ dev: 1, ino: 1 }),
      lstatTarget: async () => ({ isDirectory: () => true }),
      readdir: (path) => {
        readdirs.push(path);
        const tree: Record<string, string[]> = {
          [ROOT]: ["node_modules", "packages", "dist"],
          [`${ROOT}/packages`]: ["a", "b"],
          [`${ROOT}/packages/a`]: ["node_modules"],
          [`${ROOT}/packages/b`]: ["src"],
          [`${ROOT}/packages/b/src`]: [],
        };
        return tree[path] ?? [];
      },
    });
    roots.scan();
    await roots.settled();
    const bound = h.commands.filter((argv) => argv[1] === "--bind").map((argv) => argv[3]);
    expect(bound.sort()).toEqual([`${MOUNT}/node_modules`, `${MOUNT}/packages/a/node_modules`]);
    // Never inside a root, and never inside another local-only directory.
    expect(readdirs.some((path) => path.includes("node_modules"))).toBe(false);
    expect(readdirs.some((path) => path.includes("dist"))).toBe(false);
  });
});

describe("parking", () => {
  test("a root a caller detached is not mounted back by a lookup", async () => {
    // Otherwise `rm -rf` after a detach stats the directory, the lookup
    // mounts it again, and the rmdir gets EBUSY after all.
    const { roots, mounted } = harness({ dirs: ["node_modules"] });
    roots.ensure("node_modules", true);
    await roots.settled();
    await roots.detach("node_modules");
    roots.ensure("node_modules");
    await roots.settled();
    expect(mounted.size).toBe(0);
    roots.ensure("node_modules", true);
    await roots.settled();
    expect(mounted.size).toBe(1);
  });

  test("detachAll parks nothing, so a startup scan still mounts", async () => {
    const { roots, mounted } = harness({ dirs: ["node_modules"] });
    roots.ensure("node_modules");
    await roots.settled();
    await roots.detachAll();
    roots.scan();
    await roots.settled();
    expect(mounted.size).toBe(1);
  });

  test("a mount whose target vanished on the way is not a failure", async () => {
    const missingTargets = new Set<string>();
    const h = harness({ dirs: ["node_modules"], mountExit: 32, missingTargets });
    // The target exists for the pre-check, then is gone when the mount
    // fails, as when rm -rf removes it in between.
    let checks = 0;
    const roots = createNativeRoots({
      root: ROOT,
      mountPoint: MOUNT,
      ignore: resolveMountIgnore(["**/node_modules"], MOUNT),
      native: resolveMountIgnore(["**/node_modules"], "/").matches,
      run: async (argv) => (argv[1] === "--bind" ? 32 : 0),
      mountinfo: () => "",
      lstat: () => ({ isDirectory: () => true, dev: 1, ino: 1 }),
      lstatTarget: async () => {
        checks += 1;
        if (checks > 1) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        return { isDirectory: () => true };
      },
      stat: async () => ({ dev: 1, ino: 1 }),
      warn: (message) => h.warnings.push(message),
    });
    roots.ensure("node_modules");
    await roots.settled();
    expect(roots.stats().failures).toBe(0);
    expect(h.warnings).toEqual([]);
  });
});

describe("detach", () => {
  test("detachAll lazily detaches everything under the mount point, deepest first", async () => {
    const { roots, commands, mounted } = harness({ dirs: ["a/node_modules", "a/b/node_modules"] });
    roots.ensure("a/node_modules");
    roots.ensure("a/b/node_modules");
    await roots.settled();
    commands.length = 0;
    const detached = await roots.detachAll();
    expect(detached).toEqual([`${MOUNT}/a/b/node_modules`, `${MOUNT}/a/node_modules`]);
    expect(commands).toEqual([
      ["umount", "-l", `${MOUNT}/a/b/node_modules`],
      ["umount", "-l", `${MOUNT}/a/node_modules`],
    ]);
    expect(mounted.size).toBe(0);
    expect(roots.stats()).toMatchObject({ active: 0, detaches: 2 });
  });

  test("detach of one path leaves the others, and an unknown path is a no-op", async () => {
    const { roots, mounted } = harness({ dirs: ["a/node_modules", "b/node_modules"] });
    roots.ensure("a/node_modules");
    roots.ensure("b/node_modules");
    await roots.settled();
    expect(await roots.detach("a/node_modules")).toEqual([`${MOUNT}/a/node_modules`]);
    expect(await roots.detach("nope/node_modules")).toEqual([]);
    expect([...mounted]).toEqual([`${MOUNT}/b/node_modules`]);
  });

  test("never touches the FUSE mount itself", async () => {
    const { roots, commands } = harness();
    await roots.detachAll();
    expect(commands).toEqual([]);
  });
});

test("unescapeMountinfo decodes octal escapes", () => {
  expect(unescapeMountinfo("/workspace/my\\040app/node_modules")).toBe(
    "/workspace/my app/node_modules",
  );
  expect(unescapeMountinfo("/a\\134b")).toBe("/a\\b");
});
