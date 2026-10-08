#!/usr/bin/env node
/**
 * Runs the Vite CLI of the package in the current directory with memory-lean
 * native runtimes for local development. Arguments pass through unchanged:
 *
 *   node ../../scripts/vite-dev.mjs dev --host 127.0.0.1 --port 8793
 *
 * Rolldown sizes both of its native thread pools (Tokio and Rayon) to every
 * visible CPU, and its mimalloc heaps keep freed dependency-optimizer memory,
 * so a cold start in a shared sandbox held ~2.6 GiB RSS for the Control Panel
 * alone. These are read when Vite first loads the Rolldown binding, which is
 * why they are set here, before Vite is imported, rather than in a Vite config.
 * Miniflare passes the V8 flag to the local workerd, which holds every Worker
 * isolate. Values already in the environment win, so any of these can still be
 * overridden per run.
 */

import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const localDevRuntimeEnv = {
  ROLLDOWN_WORKER_THREADS: "2",
  RAYON_NUM_THREADS: "2",
  MIMALLOC_PURGE_DELAY: "0",
  MINIFLARE_WORKERD_V8_FLAGS: "--optimize-for-size",
};

for (const [name, value] of Object.entries(localDevRuntimeEnv)) process.env[name] ??= value;

const viteManifest = createRequire(join(process.cwd(), "package.json")).resolve(
  "vite/package.json",
);
await import(pathToFileURL(join(viteManifest, "..", "bin", "vite.js")).href);
