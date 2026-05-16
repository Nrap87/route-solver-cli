#!/usr/bin/env node
/**
 * Launcher so `npm run tsp-cron -- --every-minute …` works on Windows when paths contain spaces.
 * Resolves `tsp_cron_service.ts` next to this file and runs the package root as cwd.
 *
 * From repo root: node ./scripts/run-cron.mjs …
 * From scripts/:  node run-cron.mjs …
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

process.stdout.on("error", (err) => {
  if (err && err.code === "EPIPE") {
    process.exit(0);
  }
});

process.stderr.on("error", (err) => {
  if (err && err.code === "EPIPE") {
    process.exit(0);
  }
});

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const cronTs = join(__dirname, "tsp_cron_service.ts");
const passthrough = process.argv.slice(2);

const child = spawn(
  process.execPath,
  ["--import", "tsx", cronTs, ...passthrough],
  {
    cwd: root,
    stdio: "inherit",
    env: process.env,
    shell: false,
  }
);

child.on("error", (err) => {
  console.error(err);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  process.exit(code ?? 1);
});