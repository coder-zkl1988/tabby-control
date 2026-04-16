#!/usr/bin/env node
/**
 * Build script for Nexu Desktop packaging.
 * Outputs a deployable plugin directory at dist-nexu/lobster-device-control/
 * that can be copied into Nexu's .dist-runtime/plugins/.
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
const OUTPUT_DIR = path.join(PLUGIN_ROOT, "dist-nexu", "lobster-device-control");

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

// Install production-only dependencies in the output directory
// (avoids shipping devDependencies like eslint/typescript into the Nexu distributable)
console.log("[nexu-build] Installing production dependencies...");
execSync("pnpm install --prod --frozen-lockfile", {
  cwd: OUTPUT_DIR,
  stdio: "inherit",
});

console.log(`[nexu-build] Done → ${OUTPUT_DIR}`);
