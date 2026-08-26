/**
 * Build script: bundle the static frontend into dist/.
 *
 * The static-hosting component serves dist/ at <deployment>.convex.site.
 * Injects VITE_CONVEX_URL (set by `npx @convex-dev/static-hosting deploy`) as
 * a global so the app can reach the backend without a build system.
 */

import { build } from "esbuild";
import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const dist = join(root, "dist");

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

const convexUrl = process.env.VITE_CONVEX_URL ?? "http://127.0.0.1:3210";

await build({
  entryPoints: [join(root, "frontend", "app.ts")],
  bundle: true,
  format: "iife",
  target: "es2020",
  minify: true,
  sourcemap: false,
  outfile: join(dist, "app.js"),
  define: {
    // The frontend reads the deployment URL from this injected global.
    "globalThis.VITE_CONVEX_URL": JSON.stringify(convexUrl),
  },
  logLevel: "silent",
});

copyFileSync(join(root, "frontend", "index.html"), join(dist, "index.html"));
copyFileSync(join(root, "frontend", "styles.css"), join(dist, "styles.css"));

console.log(`[build] dist/ ready (VITE_CONVEX_URL=${convexUrl})`);
