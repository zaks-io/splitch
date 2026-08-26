import { access, appendFile, chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { applyEdits, modify, type ParseError, parse } from "jsonc-parser";
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

export const SERVICE_BINDING = "SPLITCH";
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

export async function installServiceBinding(state: CloudflareState): Promise<void> {
  const { raw, services } = await serviceBindingState(state);
  assertServiceBindingOwnership(state, services);
  if (!services.some((entry) => isRecord(entry) && entry.binding === SERVICE_BINDING))
    services.push({ binding: SERVICE_BINDING, service: state.workerName });
  await writeJsoncEdit(state.appConfigPath, raw, state.appBindingPath, services);
}

export async function assertServiceBindingAvailable(state: CloudflareState): Promise<void> {
  const { services } = await serviceBindingState(state);
  assertServiceBindingOwnership(state, services);
}

async function serviceBindingState(state: CloudflareState) {
  const raw = await readFile(state.appConfigPath, "utf8");
  const document = parseJsonc(raw, state.appConfigPath) as Record<string, unknown>;
  const current = valueAtPath(document, state.appBindingPath);
  const services = Array.isArray(current) ? [...current] : [];
  return { raw, services };
}

function assertServiceBindingOwnership(state: CloudflareState, services: unknown[]): void {
  const existing = services.find((entry) => isRecord(entry) && entry.binding === SERVICE_BINDING) as
    | Record<string, unknown>
    | undefined;
  if (existing && existing.service !== state.workerName)
    throw cloudflareUsage(
      `${SERVICE_BINDING} is already bound to ${JSON.stringify(existing.service)} in ${state.appConfigPath}`,
    );
}

export async function removeServiceBinding(state: CloudflareState): Promise<void> {
  const raw = await readFile(state.appConfigPath, "utf8");
  const document = parseJsonc(raw, state.appConfigPath) as Record<string, unknown>;
  const current = valueAtPath(document, state.appBindingPath);
  if (!Array.isArray(current)) return;
  const existing = current.find((entry) => isRecord(entry) && entry.binding === SERVICE_BINDING) as
    | Record<string, unknown>
    | undefined;
  if (existing && existing.service !== state.workerName)
    throw cloudflareUsage(
      `${SERVICE_BINDING} no longer points to ${state.workerName}; refusing to remove it`,
    );
  const next = current.filter((entry) => !(isRecord(entry) && entry.binding === SERVICE_BINDING));
  await writeJsoncEdit(state.appConfigPath, raw, state.appBindingPath, next);
}

export async function serviceBindingPath(
  configPath: string,
  environment: string,
): Promise<readonly string[]> {
  const raw = await readFile(configPath, "utf8");
  const document = parseJsonc(raw, configPath) as Record<string, unknown>;
  const environments = isRecord(document.env) ? document.env : undefined;
  if (!environments) return ["services"];
  if (isRecord(environments[environment])) return ["env", environment, "services"];
  throw cloudflareUsage(
    `Wrangler Environment ${JSON.stringify(environment)} does not exist in ${configPath}`,
  );
}

export async function findApplicationConfig(cwd: string): Promise<string> {
  for (const name of ["wrangler.jsonc", "wrangler.json"]) {
    const path = join(cwd, name);
    try {
      await access(path);
      return path;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  throw cloudflareUsage(`No wrangler.jsonc or wrangler.json exists in ${cwd}`);
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
  return state;
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

async function writeJsoncEdit(
  path: string,
  raw: string,
  propertyPath: readonly string[],
  value: unknown,
): Promise<void> {
  const edits = modify(raw, [...propertyPath], value, {
    formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" },
  });
  await writeFile(path, applyEdits(raw, edits));
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

function parseJsonc(raw: string, path: string): unknown {
  const errors: ParseError[] = [];
  const value = parse(raw, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length > 0)
    throw cloudflareUsage(`${path} is invalid JSONC at offset ${errors[0]?.offset}`);
  return value;
}

function valueAtPath(value: unknown, path: readonly string[]): unknown {
  let current = value;
  for (const part of path) {
    if (!isRecord(current)) return undefined;
    current = current[part];
  }
  return current;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
