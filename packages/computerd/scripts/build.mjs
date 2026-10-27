#!/usr/bin/env node

import { spawn } from "node:child_process";
import { chmod, copyFile, existsSync, rm } from "node:fs";
import { chmod as chmodAsync, copyFile as copyFileAsync, rm as rmAsync } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(packageRoot, "../..");
const tscBin = process.platform === "win32" ? "tsc.cmd" : "tsc";

await rmAsync(resolve(packageRoot, "dist"), { recursive: true, force: true });
await run(tscBin, ["-p", "tsconfig.json"], packageRoot);

const jsEntry = resolve(packageRoot, "dist/cli/computerd.js");
const cjsEntry = resolve(packageRoot, "dist/cli/computerd.cjs");
await copyFileAsync(jsEntry, cjsEntry);
await chmodAsync(cjsEntry, 0o755);

// Also emit a self-contained ESM bundle (`dist/cli/computerd.bundle.mjs`)
// with all JS workspace dependencies inlined so container builds (such as
// Dockerfile.desktop) do not need to copy the monorepo node_modules tree.
const bundleEntry = resolve(packageRoot, "dist/cli/computerd.bundle.mjs");
const addonSrc = resolve(repoRoot, "node_modules/fuse-native/prebuilds/linux-x64/node.napi.node");
const libfuseSrc = resolve(
  repoRoot,
  "node_modules/fuse-shared-library-linux/libfuse/lib/libfuse.so",
);
if (existsSync(addonSrc)) {
  await copyFileAsync(addonSrc, resolve(packageRoot, "dist/cli/fuse-native.node"));
}
if (existsSync(libfuseSrc)) {
  await copyFileAsync(libfuseSrc, resolve(packageRoot, "dist/cli/libfuse.so.2"));
}

const nodeGypBuildShim = `
const { existsSync } = require("node:fs");
const { join } = require("node:path");
let cached;
module.exports = function nodeGypBuild(dir) {
  if (cached) return cached;
  const localAddon = join(__dirname, "fuse-native.node");
  if (existsSync(localAddon)) {
    process.env.LD_LIBRARY_PATH = __dirname + (process.env.LD_LIBRARY_PATH ? ":" + process.env.LD_LIBRARY_PATH : "");
    const m = { exports: {} };
    process.dlopen(m, localAddon);
    cached = m.exports;
    return cached;
  }
  throw new Error("fuse-native addon not found at " + localAddon);
};
`;

const fuseSharedLibraryShim = `
function noop(cb) { if (typeof cb === "function") process.nextTick(cb); }
function isConfigured(cb) { process.nextTick(() => cb(null, true)); }
module.exports = { beforeMount: noop, beforeUnmount: noop, configure: noop, unconfigure: noop, isConfigured };
`;

await build({
  entryPoints: [cjsEntry],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  conditions: ["import", "node"],
  outfile: bundleEntry,
  banner: {
    js: [
      "import { createRequire as __cr } from 'node:module';",
      "import { dirname as __dn } from 'node:path';",
      "import { fileURLToPath as __fu } from 'node:url';",
      "const __filename = __fu(import.meta.url);",
      "const __dirname = __dn(__filename);",
      "const require = __cr(import.meta.url);",
    ].join(""),
  },
  plugins: [
    {
      name: "fuse-native-bundle-shim",
      setup(b) {
        b.onResolve({ filter: /^node-gyp-build$/ }, () => ({
          path: "node-gyp-build",
          namespace: "computerd-bundle-shim",
        }));
        b.onResolve({ filter: /^fuse-shared-library$/ }, () => ({
          path: "fuse-shared-library",
          namespace: "computerd-bundle-shim",
        }));
        b.onLoad({ filter: /.*/, namespace: "computerd-bundle-shim" }, (args) => {
          if (args.path === "node-gyp-build") {
            return { contents: nodeGypBuildShim, loader: "js", resolveDir: repoRoot };
          }
          if (args.path === "fuse-shared-library") {
            return { contents: fuseSharedLibraryShim, loader: "js" };
          }
          return null;
        });
      },
    },
  ],
  logLevel: "warning",
});
await chmodAsync(bundleEntry, 0o755);

void chmod;
void copyFile;
void rm;

function run(command, args, cwd) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: "inherit",
      shell: process.platform === "win32",
    });

    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolveRun();
        return;
      }

      reject(new Error(`${command} ${args.join(" ")} failed with ${signal ?? code}`));
    });
  });
}
