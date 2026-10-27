// Default local store for a Workspace that runs outside Cloudflare.
//
// Inside a Durable Object the caller passes `ctx.storage`. Anywhere
// else (Node.js, Docker, a script), Workspace falls back to this
// node:sqlite-backed store, either in memory or on a file.
//
// node:sqlite is reached through `process.getBuiltinModule` at
// construction time rather than a static import, so this module
// still loads under workerd, which has no node:sqlite.

import type { DurableObjectStorageLike, SQLCursorLike } from "@cloudflare/dofs";

interface StatementLike {
  all(...params: unknown[]): unknown[];
}
interface DatabaseLike {
  prepare(sql: string): StatementLike;
  exec(sql: string): void;
  close(): void;
}
interface NodeFsLike {
  mkdirSync(path: string, options: { recursive: boolean }): void;
}
interface NodePathLike {
  dirname(path: string): string;
}

type BuiltinLoader = (id: string) => unknown;

function builtin<T>(id: string): T {
  const proc = (globalThis as { process?: { getBuiltinModule?: BuiltinLoader } }).process;
  const mod = proc?.getBuiltinModule?.(id);
  if (!mod) {
    throw new Error(
      `Workspace: no \`storage\` was provided and ${id} is unavailable in this runtime. ` +
        "Pass a Durable Object storage, or run on Node.js 22.5 or later.",
    );
  }
  return mod as T;
}

export class NodeSQLiteStorage implements DurableObjectStorageLike {
  readonly location: string;
  readonly sql: DurableObjectStorageLike["sql"];
  readonly #db: DatabaseLike;
  readonly #cache = new Map<string, StatementLike>();

  constructor(location: string = ":memory:") {
    this.location = location;
    const { DatabaseSync } = builtin<{ DatabaseSync: new (path: string) => DatabaseLike }>(
      "node:sqlite",
    );
    const onDisk = location !== ":memory:";
    if (onDisk) {
      const fs = builtin<NodeFsLike>("node:fs");
      const path = builtin<NodePathLike>("node:path");
      fs.mkdirSync(path.dirname(location), { recursive: true });
    }
    this.#db = new DatabaseSync(location);
    if (onDisk) {
      this.#db.exec("PRAGMA journal_mode = wal");
      this.#db.exec("PRAGMA synchronous = normal");
      this.#db.exec("PRAGMA busy_timeout = 5000");
    }
    this.sql = {
      exec: (query: string, ...bindings: unknown[]): SQLCursorLike => {
        let stmt = this.#cache.get(query);
        if (stmt === undefined) {
          stmt = this.#db.prepare(query);
          this.#cache.set(query, stmt);
        }
        const rows = (stmt.all(...bindings.map(toSQLiteValue)) ?? []) as Record<string, unknown>[];
        return { toArray: () => rows } as SQLCursorLike;
      },
    };
  }

  transactionSync<T>(closure: () => T): T {
    this.#db.exec("BEGIN");
    try {
      const result = closure();
      this.#db.exec("COMMIT");
      return result;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  close(): void {
    this.#cache.clear();
    this.#db.close();
  }
}

function toSQLiteValue(value: unknown): unknown {
  if (value === undefined || value === null) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (
    value instanceof Uint8Array ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "bigint"
  ) {
    return value;
  }
  throw new TypeError(`NodeSQLiteStorage cannot bind value of type ${typeof value}`);
}
