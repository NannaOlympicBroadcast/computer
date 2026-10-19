import { defineConfig } from "tsdown";

export default defineConfig({
  // `cli/computerd` lands at dist/cli/computerd.cjs, the `bin` path.
  // build:bin bundles that file again with esbuild for the SEA binary.
  entry: { "cli/computerd": "src/cli/computerd.ts" },
  // CJS to match `"type": "commonjs"` and the `.cjs` bin. The target
  // comes from `engines.node`.
  format: "cjs",
  platform: "node",
  sourcemap: true,
});
