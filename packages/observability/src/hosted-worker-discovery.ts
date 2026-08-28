import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { parseConfigFileTextToJson } from "typescript";
import {
  classFetchIsWrapped,
  exportedWorkerEntrypoints,
  proveClassFetchWrapped,
  proveDefaultExportWrapped,
  unsupportedExportedFetchFailures,
} from "./hosted-worker-wrap-gate.js";

interface WranglerServiceBinding {
  service?: string;
  entrypoint?: string;
}

interface WranglerEnv {
  name?: string;
  services?: WranglerServiceBinding[];
}

interface WranglerConfig {
  name?: string;
  main?: string;
  services?: WranglerServiceBinding[];
  env?: Record<string, WranglerEnv | undefined>;
}

interface ReferencedEntrypoint {
  readonly service: string;
  readonly entrypoint: string;
}

export interface HostedWorker {
  configPath: string;
  name: string;
  mainPath: string;
  source: string;
  serviceNames: string[];
  referencedEntrypoints: ReferencedEntrypoint[];
}

export interface WorkerFixtureFiles {
  readonly directory?: string;
  readonly wrangler: string;
  readonly source: string;
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

export function discoverFixture(files: WorkerFixtureFiles): HostedWorker[] {
  return discoverFixtures([files]);
}

export function discoverFixtures(workers: readonly WorkerFixtureFiles[]): HostedWorker[] {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "unwrapped-worker-"));
  try {
    for (const [index, files] of workers.entries()) {
      const directory = join(fixtureRoot, files.directory ?? `worker-${index}`);
      mkdirSync(directory, { recursive: true });
      const configPath = join(directory, "wrangler.jsonc");
      writeFileSync(configPath, files.wrangler);
      const config = readWranglerConfig(configPath);
      const mainPath = join(directory, config.main ?? "index.ts");
      mkdirSync(dirname(mainPath), { recursive: true });
      writeFileSync(mainPath, files.source);
    }
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
    const fallbackName = config.name ?? rel;
    workers.push({
      configPath,
      name: fallbackName,
      mainPath,
      source: readFileSync(mainPath, "utf8"),
      serviceNames: collectServiceNames(config, fallbackName),
      referencedEntrypoints: collectReferencedEntrypoints(config),
    });
  }
  return workers;
}

export function omissionFailures(discovered: HostedWorker[]): string[] {
  const wrappedByService = wrappedEntrypointsByService(discovered);
  return discovered.flatMap((worker) => [
    ...unwrappedDefaultFailures(worker),
    ...unsupportedExportedFetchFailures(worker.source, worker.mainPath),
    ...unwrappedClassFailures(worker),
    ...unwrappedBindingFailures(worker, wrappedByService),
  ]);
}

function collectServiceNames(config: WranglerConfig, fallback: string): string[] {
  const names = new Set<string>();
  if (config.name) names.add(config.name);
  for (const target of Object.values(config.env ?? {})) {
    if (target?.name) names.add(target.name);
  }
  if (names.size === 0) names.add(fallback);
  return [...names];
}

function wrappedEntrypointsByService(discovered: HostedWorker[]): Map<string, Set<string>> {
  const byService = new Map<string, Set<string>>();
  for (const worker of discovered) {
    const classes = exportedWorkerEntrypoints(worker.source).filter((className) =>
      classFetchIsWrapped(worker.source, className),
    );
    for (const serviceName of worker.serviceNames) {
      const existing = byService.get(serviceName) ?? new Set<string>();
      for (const className of classes) existing.add(className);
      byService.set(serviceName, existing);
    }
  }
  return byService;
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

function unwrappedBindingFailures(
  worker: HostedWorker,
  wrappedByService: Map<string, Set<string>>,
): string[] {
  return worker.referencedEntrypoints
    .filter((binding) => !wrappedByService.get(binding.service)?.has(binding.entrypoint))
    .map(
      (binding) =>
        `configured entrypoint ${binding.entrypoint} is unwrapped for service ${binding.service}`,
    );
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

function collectReferencedEntrypoints(config: WranglerConfig): ReferencedEntrypoint[] {
  const refs: ReferencedEntrypoint[] = [];
  const seen = new Set<string>();
  const add = (services: WranglerServiceBinding[] | undefined): void => {
    for (const service of services ?? []) {
      if (!service.entrypoint) continue;
      const target = service.service ?? "";
      const key = `${target}\0${service.entrypoint}`;
      if (seen.has(key)) continue;
      seen.add(key);
      refs.push({ service: target, entrypoint: service.entrypoint });
    }
  };
  add(config.services);
  for (const target of Object.values(config.env ?? {})) {
    add(target?.services);
  }
  return refs;
}
