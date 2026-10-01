import {
  access,
  appendFile,
  chmod,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import { findPackageJSON } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { boundServices, isRecord } from "./cloudflare-binding.js";
import { cloudflareUsage } from "./cloudflare-error.js";
import type { CliDeps } from "./execute-types.js";
import { resolveDataPlaneBaseUrl } from "./sdks.js";

export interface CloudflareState {
  readonly version: 1;
  readonly environment: string;
  readonly workerName: string;
  readonly installationId: string;
  readonly pushSecret: string;
  readonly endpoint: string;
  readonly appConfigPath: string;
  readonly appBindingPath: readonly string[];
  readonly removedAt?: string;
}

const COMPATIBILITY_DATE = "2026-08-22";
const WORKER_PREFIX = "splitch-config-";
const STATE_GITIGNORE_PATTERN = ".splitch/cloudflare/*/state.json";

export function generatedPaths(cwd: string, environment: string) {
  const directory = join(cwd, ".splitch", "cloudflare", safeSegment(environment));
  return {
    directory,
    configPath: join(directory, "wrangler.jsonc"),
    entryPath: join(directory, "worker.ts"),
    statePath: join(directory, "state.json"),
  };
}

/**
 * Integration configs the application config binds. The committed configs and bindings, not the
 * ignored state files, decide this, so every clone generates the same types and a removed binding
 * drops its integration. A bound integration Worker without exactly one generated config fails,
 * because skipping it would silently retype its `SPLITCH` as an untyped `Fetcher`.
 */
export async function boundIntegrationConfigs(
  cwd: string,
  appConfigPath: string,
): Promise<string[]> {
  const generated = await generatedConfigsByWorker(cwd);
  const configs: string[] = [];
  for (const worker of await boundServices(appConfigPath)) {
    if (!worker.startsWith(WORKER_PREFIX)) continue;
    const [config, ...duplicates] = generated.get(worker) ?? [];
    if (config === undefined)
      throw cloudflareUsage(
        `${appConfigPath} binds ${worker}, but no .splitch/cloudflare/<env>/wrangler.jsonc generates it; restore that directory from version control`,
      );
    if (duplicates.length > 0)
      throw cloudflareUsage(
        `${appConfigPath} binds ${worker}, which ${[config, ...duplicates].join(" and ")} all generate; delete the stale ones`,
      );
    configs.push(config);
  }
  return configs.sort();
}

async function generatedConfigsByWorker(cwd: string): Promise<Map<string, string[]>> {
  const byWorker = new Map<string, string[]>();
  for (const environment of await integrationDirectories(cwd)) {
    const { configPath } = generatedPaths(cwd, environment);
    if (!(await fileExists(configPath))) continue;
    const worker = integrationWorkerName(environment);
    byWorker.set(worker, [...(byWorker.get(worker) ?? []), configPath]);
  }
  return byWorker;
}

async function integrationDirectories(cwd: string): Promise<string[]> {
  try {
    const entries = await readdir(join(cwd, ".splitch", "cloudflare"));
    return entries.filter(isSafeSegment);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return false;
    throw error;
  }
}

export async function writeIntegrationFiles(
  paths: ReturnType<typeof generatedPaths>,
  state: CloudflareState,
  deps: CliDeps,
): Promise<void> {
  await mkdir(paths.directory, { recursive: true });
  const entry = 'export { default, SplitchState } from "@splitch/cloudflare/worker";\n';
  const endpoint = resolveDataPlaneBaseUrl(deps).replace(/\/$/, "");
  const config = {
    $schema: "../../../node_modules/wrangler/config-schema.json",
    name: state.workerName,
    main: "worker.ts",
    compatibility_date: COMPATIBILITY_DATE,
    compatibility_flags: ["nodejs_compat"],
    vars: { SPLITCH_INSTALLATION_ID: state.installationId, SPLITCH_ENDPOINT: endpoint },
    durable_objects: { bindings: [{ name: "SPLITCH_STATE", class_name: "SplitchState" }] },
    migrations: [{ tag: "v1", new_sqlite_classes: ["SplitchState"] }],
    observability: {
      enabled: true,
      logs: { head_sampling_rate: 1 },
      traces: { enabled: true, head_sampling_rate: 0.01 },
    },
  };
  await writeFile(paths.entryPath, entry, { flag: "w" });
  await writeFile(paths.configPath, `${JSON.stringify(config, null, 2)}\n`, { flag: "w" });
  await writeState(paths.statePath, state);
}

export async function ensureCloudflareStateIgnored(cwd: string): Promise<void> {
  const path = join(cwd, ".gitignore");
  let raw = "";
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (raw.split(/\r?\n/).includes(STATE_GITIGNORE_PATTERN)) return;
  const prefix = raw.length > 0 && !raw.endsWith("\n") ? "\n" : "";
  await appendFile(path, `${prefix}${STATE_GITIGNORE_PATTERN}\n`);
}

export async function findApplicationConfig(cwd: string): Promise<string> {
  const projectRoot = await realpath(cwd);
  for (const name of ["wrangler.jsonc", "wrangler.json"]) {
    const path = join(projectRoot, name);
    try {
      return await canonicalApplicationConfig(path, projectRoot);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  throw cloudflareUsage(`No wrangler.jsonc or wrangler.json exists in ${projectRoot}`);
}

async function canonicalApplicationConfig(path: string, projectRoot: string): Promise<string> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw cloudflareUsage(`Application config ${path} must be a regular file, not a link`);
  }
  const canonicalPath = await realpath(path);
  if (dirname(canonicalPath) !== projectRoot) {
    throw cloudflareUsage(`Application config ${path} resolves outside the current App`);
  }
  return canonicalPath;
}

export async function assertGeneratedTargetsAvailable(
  paths: ReturnType<typeof generatedPaths>,
): Promise<void> {
  for (const path of [paths.configPath, paths.entryPath]) {
    try {
      await access(path);
      throw cloudflareUsage(`${path} already exists without a Splitch Cloudflare state file`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

// @splitch/cloudflare only exports `import` conditions, so CommonJS resolution
// rejects it with ERR_PACKAGE_PATH_NOT_EXPORTED even when it is installed.
export async function assertCloudflarePackage(cwd: string): Promise<void> {
  const notInstalled = "@splitch/cloudflare is not installed in this App";
  try {
    const manifest = findPackageJSON(
      "@splitch/cloudflare",
      pathToFileURL(join(cwd, "package.json")),
    );
    if (manifest === undefined) throw cloudflareUsage(notInstalled);
    // findPackageJSON only locates the package directory; a half-installed one has no manifest.
    await access(manifest);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ERR_MODULE_NOT_FOUND" && code !== "ENOENT") throw error;
    throw cloudflareUsage(notInstalled, error);
  }
}

export async function requireState(cwd: string, environment: string): Promise<CloudflareState> {
  const state = await readState(generatedPaths(cwd, environment).statePath);
  if (!state) throw cloudflareUsage(`No Cloudflare integration is installed for ${environment}`);
  assertStateEnvironment(state, environment);
  return assertStateProject(cwd, environment, state);
}

export async function assertStateProject(
  cwd: string,
  environment: string,
  state: CloudflareState,
): Promise<CloudflareState> {
  if (state.environment !== environment) {
    throw cloudflareUsage(`Cloudflare state belongs to ${state.environment}, not ${environment}`);
  }
  const expectedWorkerName = workerName(environment);
  if (state.workerName !== expectedWorkerName) {
    throw cloudflareUsage(`Cloudflare state names an unexpected Worker; refusing to continue`);
  }
  const expectedConfigPath = await findApplicationConfig(cwd);
  const projectRoot = await realpath(cwd);
  const actualConfigPath = await canonicalApplicationConfig(state.appConfigPath, projectRoot);
  if (actualConfigPath !== expectedConfigPath) {
    throw cloudflareUsage(`Cloudflare state points outside the current App configuration`);
  }
  return state.appConfigPath === actualConfigPath
    ? state
    : { ...state, appConfigPath: actualConfigPath };
}

export async function readState(path: string): Promise<CloudflareState | null> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (!isCloudflareState(value))
      throw cloudflareUsage(`${path} is not a Splitch Cloudflare state file`);
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function writeState(path: string, state: CloudflareState): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
}

export function assertStateEnvironment(state: CloudflareState, environment: string): void {
  if (state.environment !== environment)
    throw cloudflareUsage(`Cloudflare state belongs to ${state.environment}, not ${environment}`);
  if (state.removedAt)
    throw cloudflareUsage(`The Cloudflare integration for ${environment} was removed`);
}

export function workerName(environment: string): string {
  const name = integrationWorkerName(safeSegment(environment));
  if (name.length > 63)
    throw cloudflareUsage(`Environment ${environment} produces a Worker name over 63 characters`);
  return name;
}

function integrationWorkerName(segment: string): string {
  const suffix = segment.toLowerCase().replace(/[^a-z0-9-]/g, "-");
  return `${WORKER_PREFIX}${suffix}`.replace(/-+/g, "-").replace(/-$/, "");
}

function isCloudflareState(value: unknown): value is CloudflareState {
  return (
    isRecord(value) &&
    value.version === 1 &&
    typeof value.environment === "string" &&
    typeof value.workerName === "string" &&
    typeof value.installationId === "string" &&
    typeof value.pushSecret === "string" &&
    typeof value.endpoint === "string" &&
    typeof value.appConfigPath === "string" &&
    Array.isArray(value.appBindingPath) &&
    value.appBindingPath.every((part) => typeof part === "string")
  );
}

function isSafeSegment(value: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(value) && value !== "." && value !== "..";
}

function safeSegment(value: string): string {
  if (!isSafeSegment(value))
    throw cloudflareUsage(
      `Environment ${JSON.stringify(value)} cannot be used as a local integration path`,
    );
  return value;
}
