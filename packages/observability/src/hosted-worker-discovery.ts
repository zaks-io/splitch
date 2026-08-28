import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { parseConfigFileTextToJson } from "typescript";
import {
  classFetchIsWrapped,
  exportedWorkerEntrypoints,
  proveClassFetchWrapped,
  proveDefaultExportWrapped,
} from "./hosted-worker-wrap-gate.js";

interface WranglerConfig {
  name?: string;
  main?: string;
  services?: Array<{ entrypoint?: string }>;
  env?: Record<string, { name?: string; services?: Array<{ entrypoint?: string }> } | undefined>;
}

export interface HostedWorker {
  configPath: string;
  name: string;
  mainPath: string;
  source: string;
  referencedEntrypoints: string[];
}

const WRANGLER_WALK_SKIP = new Set([
  "node_modules",
  "dist",
  ".git",
  ".turbo",
  "coverage",
  ".wrangler",
  ".output",
]);

export function discoverFixture(files: { wrangler: string; source: string }): HostedWorker[] {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "unwrapped-worker-"));
  try {
    writeFileSync(join(fixtureRoot, "wrangler.jsonc"), files.wrangler);
    const config = readWranglerConfig(join(fixtureRoot, "wrangler.jsonc"));
    const mainPath = join(fixtureRoot, config.main ?? "index.ts");
    mkdirSync(dirname(mainPath), { recursive: true });
    writeFileSync(mainPath, files.source);
    return discoverDeployableWorkers(fixtureRoot);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

export function discoverDeployableWorkers(root: string): HostedWorker[] {
  const workers: HostedWorker[] = [];
  for (const configPath of listWranglerConfigs(root)) {
    const rel = relative(root, configPath);
    if (isTestWranglerPath(rel)) continue;
    const config = readWranglerConfig(configPath);
    if (!config.main) continue;
    const mainPath = join(dirname(configPath), config.main);
    workers.push({
      configPath,
      name: config.name ?? rel,
      mainPath,
      source: readFileSync(mainPath, "utf8"),
      referencedEntrypoints: collectReferencedEntrypoints(config),
    });
  }
  return workers;
}

export function omissionFailures(discovered: HostedWorker[]): string[] {
  const wrappedClasses = wrappedEntrypointNames(discovered);
  return discovered.flatMap((worker) => [
    ...unwrappedDefaultFailures(worker),
    ...unwrappedClassFailures(worker),
    ...unwrappedBindingFailures(worker, wrappedClasses),
  ]);
}

function wrappedEntrypointNames(discovered: HostedWorker[]): Set<string> {
  return new Set(
    discovered.flatMap((worker) =>
      exportedWorkerEntrypoints(worker.source).filter((className) =>
        classFetchIsWrapped(worker.source, className),
      ),
    ),
  );
}

function unwrappedDefaultFailures(worker: HostedWorker): string[] {
  const proof = proveDefaultExportWrapped(worker.source, worker.mainPath);
  if (proof.wrapped) return [];
  return [
    `${worker.mainPath} default export is unwrapped${proof.reason ? `: ${proof.reason}` : ""}${
      proof.location ? ` (${proof.location})` : ""
    }`,
  ];
}

function unwrappedClassFailures(worker: HostedWorker): string[] {
  return exportedWorkerEntrypoints(worker.source)
    .map((className) => {
      const proof = proveClassFetchWrapped(worker.source, className, worker.mainPath);
      return proof.wrapped
        ? undefined
        : `${worker.mainPath} ${className}.fetch is unwrapped${
            proof.reason ? `: ${proof.reason}` : ""
          }${proof.location ? ` (${proof.location})` : ""}`;
    })
    .filter((failure): failure is string => failure !== undefined);
}

function unwrappedBindingFailures(worker: HostedWorker, wrappedClasses: Set<string>): string[] {
  return worker.referencedEntrypoints
    .filter((entrypoint) => !wrappedClasses.has(entrypoint))
    .map((entrypoint) => `configured entrypoint ${entrypoint} is unwrapped`);
}

function isTestWranglerPath(rel: string): boolean {
  return (
    /(^|[/\\])(tests?|__tests__|fixtures|__fixtures__)([/\\]|$)/.test(rel) || /\.test\./.test(rel)
  );
}

function listWranglerConfigs(root: string): string[] {
  return walkWranglerConfigs(root).sort();
}

function walkWranglerConfigs(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!WRANGLER_WALK_SKIP.has(entry.name)) found.push(...walkWranglerConfigs(path));
      continue;
    }
    if (entry.name === "wrangler.jsonc") found.push(path);
  }
  return found;
}

function readWranglerConfig(path: string): WranglerConfig {
  const parsed = parseConfigFileTextToJson(path, readFileSync(path, "utf8"));
  if (parsed.error) {
    throw new Error(parsed.error.messageText.toString());
  }
  return parsed.config as WranglerConfig;
}

function collectReferencedEntrypoints(config: WranglerConfig): string[] {
  const names = new Set(entrypointNames(config.services));
  for (const target of Object.values(config.env ?? {})) {
    for (const name of entrypointNames(target?.services)) names.add(name);
  }
  return [...names];
}

function entrypointNames(services: Array<{ entrypoint?: string }> | undefined): string[] {
  return (services ?? []).flatMap((service) => (service.entrypoint ? [service.entrypoint] : []));
}
