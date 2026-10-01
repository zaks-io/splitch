import {
  access,
  appendFile,
  chmod,
  lstat,
  mkdir,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { isRecord } from "./cloudflare-binding.js";
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

export async function assertCloudflarePackage(cwd: string): Promise<void> {
  try {
    createRequire(join(cwd, "package.json")).resolve("@splitch/cloudflare/worker");
  } catch (error) {
    throw cloudflareUsage("@splitch/cloudflare is not installed in this App", error);
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
  const suffix = safeSegment(environment)
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-");
  const name = `splitch-config-${suffix}`.replace(/-+/g, "-").replace(/-$/, "");
  if (name.length > 63)
    throw cloudflareUsage(`Environment ${environment} produces a Worker name over 63 characters`);
  return name;
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

function safeSegment(value: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(value) || value === "." || value === "..")
    throw cloudflareUsage(
      `Environment ${JSON.stringify(value)} cannot be used as a local integration path`,
    );
  return value;
}
