import { build } from "esbuild";
import { access } from "node:fs/promises";

await build({
  entryPoints: ["src/content/index.ts"],
  bundle: true,
  format: "iife",
  target: "chrome116",
  outfile: "dist/content.js",
  sourcemap: true,
});

await access("dist/manifest.json");
await access("dist/icons/icon128.png");
console.log("[build] extension assembled in dist/");
