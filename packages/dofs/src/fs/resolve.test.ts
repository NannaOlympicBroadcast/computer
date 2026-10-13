import { describe, expect, it } from "vitest";

import { ROOT_INODE } from "../schema/index.js";
import type { Database } from "../storage.js";
import { RESOLVE_WALK_SQL, resolveInode, resolveInodeWithoutSymlinks } from "./resolve.js";
import { withDB } from "./with-db.js";

// Convenience: insert a node row and a dirent under a given parent.
// Returns the new inode. type defaults to 'file' so directory tests are
// explicit.
function addNode(
  db: Database,
  parentInode: number,
  name: string,
  options: { type?: "file" | "dir"; mode?: number; mtime?: number } = {},
): number {
  const type = options.type ?? "file";
  const mode = options.mode ?? (type === "dir" ? 0o755 : 0o644);
  const mtime = options.mtime ?? 0;
  db.run("INSERT INTO vfs_nodes (type, mode, mtime, rev) VALUES (?, ?, ?, 0)", type, mode, mtime);
  const inode = db.scalar<number>("SELECT last_insert_rowid()");
  if (inode === undefined) {
    throw new Error("failed to allocate inode");
  }
  db.run(
    "INSERT INTO vfs_dirents (parent_inode, name, child_inode) VALUES (?, ?, ?)",
    parentInode,
    name,
    inode,
  );
  return inode;
}

describe("resolveInode", () => {
  it("resolves the root", async () => {
    await withDB(
      (db) => {
        expect(resolveInode(db, "/")).toEqual({
          inode: ROOT_INODE,
          type: "dir",
          mode: 0o755,
          mtime: 0,
          size: 0,
        });
      },
      { now: () => 0 },
    );
  });

  it("resolves a top-level file", async () => {
    await withDB((db) => {
      const inode = addNode(db, ROOT_INODE, "hello.txt", { type: "file", mode: 0o644, mtime: 99 });
      expect(resolveInode(db, "/hello.txt")).toEqual({
        inode,
        type: "file",
        mode: 0o644,
        mtime: 99,
        size: 0,
      });
    });
  });

  it("resolves a nested directory", async () => {
    await withDB((db) => {
      const dir = addNode(db, ROOT_INODE, "a", { type: "dir" });
      const sub = addNode(db, dir, "b", { type: "dir" });
      const leaf = addNode(db, sub, "c.txt", { type: "file", mtime: 7 });
      expect(resolveInode(db, "/a/b/c.txt")).toEqual({
        inode: leaf,
        type: "file",
        mode: 0o644,
        mtime: 7,
        size: 0,
      });
    });
  });

  it("returns null when the final segment is missing", async () => {
    await withDB((db) => {
      addNode(db, ROOT_INODE, "a", { type: "dir" });
      expect(resolveInode(db, "/a/missing")).toBeNull();
    });
  });

  it("returns null when an intermediate segment is missing", async () => {
    await withDB((db) => {
      expect(resolveInode(db, "/no/such/path")).toBeNull();
    });
  });

  it("returns null when an intermediate segment is a file (not a dir)", async () => {
    await withDB((db) => {
      addNode(db, ROOT_INODE, "a", { type: "file" });
      expect(resolveInode(db, "/a/b")).toBeNull();
    });
  });
});

describe("resolve walk", () => {
  it("seeks each dirent on the full (parent_inode, name) key", async () => {
    await withDB((db) => {
      const plan = db
        .all<{ detail: string }>(
          `EXPLAIN QUERY PLAN ${RESOLVE_WALK_SQL}`,
          JSON.stringify(["a", "b"]),
          ROOT_INODE,
        )
        .map((r) => r.detail);
      // Before the fix the walk read `SEARCH d USING PRIMARY KEY
      // (parent_inode=?)` — every child of the directory — and matched
      // the name afterwards against a json_each scan.
      const direntSteps = plan.filter((d) => /^(SEARCH|SCAN) d\b/.test(d));
      expect(direntSteps).toEqual(["SEARCH d USING PRIMARY KEY (parent_inode=? AND name=?)"]);
      expect(plan.some((d) => d.includes("json_each"))).toBe(false);
    });
  });

  it("resolves through and into a wide directory", async () => {
    await withDB((db) => {
      const wide = addNode(db, ROOT_INODE, "wide", { type: "dir" });
      const inodes: number[] = [];
      for (let i = 0; i < 500; i++) {
        inodes.push(addNode(db, wide, `entry-${i}`, { type: i % 2 === 0 ? "dir" : "file" }));
      }
      const deep = addNode(db, inodes[0], "deep.txt", { type: "file", mtime: 3 });

      expect(resolveInodeWithoutSymlinks(db, "/wide")?.inode).toBe(wide);
      expect(resolveInodeWithoutSymlinks(db, "/wide/entry-0")?.inode).toBe(inodes[0]);
      expect(resolveInodeWithoutSymlinks(db, "/wide/entry-499")?.inode).toBe(inodes[499]);
      expect(resolveInodeWithoutSymlinks(db, "/wide/entry-0/deep.txt")?.inode).toBe(deep);
      expect(resolveInodeWithoutSymlinks(db, "/wide/missing")).toBeNull();
      expect(resolveInodeWithoutSymlinks(db, "/wide/entry-499/missing")).toBeNull();
      expect(resolveInodeWithoutSymlinks(db, "/wide/entry-1/below-a-file")).toBeNull();
      expect(resolveInodeWithoutSymlinks(db, "/")?.inode).toBe(ROOT_INODE);
    });
  });

  it("matches names that look like JSON, paths or numbers", async () => {
    await withDB((db) => {
      // The segment is read with json_extract, so names must round-trip
      // as strings: no numeric coercion, no path or quote interpretation.
      const names = [
        "1",
        "01",
        "1.0",
        "true",
        "null",
        "$",
        "$[0]",
        'a"b',
        "a\\b",
        "[]",
        "{}",
        "é ü 漢",
        "  ",
      ];
      for (const name of names) {
        const dir = addNode(db, ROOT_INODE, name, { type: "dir" });
        const child = addNode(db, dir, name, { type: "file" });
        expect(resolveInodeWithoutSymlinks(db, `/${name}`)?.inode).toBe(dir);
        expect(resolveInodeWithoutSymlinks(db, `/${name}/${name}`)?.inode).toBe(child);
        expect(resolveInode(db, `/${name}/${name}`)?.inode).toBe(child);
      }
      // A numeric-looking name must not match its numeric twin.
      expect(resolveInodeWithoutSymlinks(db, "/1.00")).toBeNull();
    });
  });
});
