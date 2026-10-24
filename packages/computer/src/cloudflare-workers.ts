// Runtime-agnostic bridge for `cloudflare:workers` base classes.
//
// Under `workerd` (Cloudflare Workers, Durable Objects, wrangler dev,
// @cloudflare/vitest-pool-workers), `capnweb` resolves its `"workerd"`
// export condition, which imports `* as cfw from "cloudflare:workers"`
// and attaches the module namespace to `globalThis[Symbol("workers-module")]`.
// When `nodejs_compat` is active, `process.getBuiltinModule("cloudflare:workers")`
// also returns the native module.
//
// Under Node.js, Bun, or Deno outside `workerd`, neither is present and
// a static `import "cloudflare:workers"` would fail ESM resolution with
// `ERR_UNSUPPORTED_ESM_URL_SCHEME`. Resolving `WorkerEntrypoint`
// dynamically here lets `@cloudflare/computer` load in plain Node.js
// without `--import` loader hooks while preserving the genuine native
// `WorkerEntrypoint` and `RpcTarget` classes inside `workerd`.

import { RpcTarget } from "capnweb";

interface CloudflareWorkersModule {
  WorkerEntrypoint?: typeof WorkerEntrypoint;
  RpcTarget?: typeof RpcTarget;
}

function resolveCloudflareWorkersModule(): CloudflareWorkersModule | undefined {
  // 1. Check `process.getBuiltinModule("cloudflare:workers")` if available.
  const proc = (
    globalThis as {
      process?: { getBuiltinModule?: (id: string) => unknown };
    }
  ).process;
  if (typeof proc?.getBuiltinModule === "function") {
    try {
      const mod = proc.getBuiltinModule("cloudflare:workers") as
        | CloudflareWorkersModule
        | undefined;
      if (mod && typeof mod === "object" && typeof mod.WorkerEntrypoint === "function") {
        return mod;
      }
    } catch {
      // Not available in this runtime.
    }
  }

  // 2. Check the symbol slot populated by `capnweb`'s workerd entrypoint.
  for (const sym of Object.getOwnPropertySymbols(globalThis)) {
    if (sym.description === "workers-module") {
      const mod = (globalThis as Record<symbol, unknown>)[sym] as
        | CloudflareWorkersModule
        | undefined;
      if (mod && typeof mod === "object" && typeof mod.WorkerEntrypoint === "function") {
        return mod;
      }
    }
  }

  return undefined;
}

class FallbackWorkerEntrypoint<Env = unknown, Props = unknown> {
  protected ctx: ExecutionContext<Props>;
  protected env: Env;

  constructor(ctx?: ExecutionContext<Props>, env?: Env) {
    this.ctx = ctx as ExecutionContext<Props>;
    this.env = env as Env;
  }

  async fetch(_request: Request): Promise<Response> {
    return new Response(null, { status: 404 });
  }
}

const cfw = resolveCloudflareWorkersModule();

export const WorkerEntrypoint: typeof globalThis extends {
  WorkerEntrypoint: infer T;
}
  ? T
  : typeof FallbackWorkerEntrypoint = (cfw?.WorkerEntrypoint ??
  FallbackWorkerEntrypoint) as typeof WorkerEntrypoint;

export { RpcTarget };
