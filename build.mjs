import * as esbuild from "esbuild";
import path from "node:path";

const STUB = path.resolve("src/background/shims/node-empty.js");

/**
 * The Anthropic SDK lazily `await import("node:fs")` inside its Node-only
 * credential-file loaders. Those branches are unreachable in a service worker
 * (we always pass an explicit apiKey), but the bundler still has to resolve the
 * specifier — so point every `node:*` import at an inert stub.
 */
const stubNodeBuiltins = {
  name: "stub-node-builtins",
  setup(build) {
    build.onResolve({ filter: /^node:/ }, () => ({ path: STUB }));
  },
};

const options = {
  entryPoints: ["src/background/index.js"],
  outfile: "dist/background.js",
  bundle: true,
  format: "esm",
  platform: "browser",
  target: ["chrome116"],
  legalComments: "none",
  logLevel: "info",
  plugins: [stubNodeBuiltins],
  define: { "process.env.NODE_ENV": '"production"' },
};

if (process.argv.includes("--watch")) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log("watching src/background ...");
} else {
  await esbuild.build(options);
}
