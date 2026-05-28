#!/usr/bin/env node
/**
 * Build script for Tabby Desktop packaging.
 * Outputs a deployable plugin directory at dist-nexu/tabby-control/
 * that can be copied into Tabby's .dist-runtime/plugins/.
 *
 * Usage: node scripts/build-nexu.mjs
 *   or:  pnpm build:nexu
 */
import { cp, mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { execSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(__dirname, "..");
const OUTPUT_DIR = path.join(PLUGIN_ROOT, "dist-nexu", "tabby-control");

console.log("[nexu-build] Building plugin...");
execSync("pnpm build", { cwd: PLUGIN_ROOT, stdio: "inherit" });

console.log("[nexu-build] Assembling deployable directory...");
await rm(OUTPUT_DIR, { recursive: true, force: true });
await mkdir(OUTPUT_DIR, { recursive: true });

// Copy dist output, manifests, and lockfile
for (const entry of ["dist", "openclaw.plugin.json", "package.json", "pnpm-lock.yaml"]) {
  await cp(
    path.join(PLUGIN_ROOT, entry),
    path.join(OUTPUT_DIR, entry),
    { recursive: true, dereference: true, force: true }
  );
}

// Install production-only dependencies in the output directory.
// Use npm instead of pnpm because pnpm's hoisted linker still does not
// install transitive deps that packages require() internally (e.g. aedes
// requires fastparallel which require()s reusify). npm creates a true
// flat node_modules where all transitive deps are reachable by Node.js.
console.log("[nexu-build] Installing production dependencies (npm)...");
execSync("npm install --omit=dev --no-package-lock", {
  cwd: OUTPUT_DIR,
  stdio: "inherit",
});

console.log(`[nexu-build] Done → ${OUTPUT_DIR}`);
