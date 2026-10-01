import { readFile, writeFile } from "node:fs/promises";
import { applyEdits, modify, type ParseError, parse } from "jsonc-parser";
import { cloudflareUsage } from "./cloudflare-error.js";
import type { CloudflareState } from "./cloudflare-files.js";

export const SERVICE_BINDING = "SPLITCH";

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

/**
 * remove has to work after the recorded Wrangler environment is renamed or deleted, so it checks
 * only the shape of the recorded path, then refuses while any other binding still points at the
 * Worker it deletes. Resolves false when the recorded Wrangler environment is gone.
 */
export async function assertServiceBindingsRemovable(state: CloudflareState): Promise<boolean> {
  const name = recordedWranglerEnvironment(state);
  if (name === undefined && !isTopLevelBinding(state))
    throw cloudflareUsage(`Cloudflare state points at an unexpected service binding`);
  const document = await readConfig(state.appConfigPath);
  const recorded = state.appBindingPath.join(".");
  const others = serviceLists(document).flatMap(({ path, services }) =>
    services
      .filter((entry) => isRecord(entry) && entry.service === state.workerName)
      .filter((entry) => path !== recorded || entry.binding !== SERVICE_BINDING)
      .map((entry) => `${path} (${String(entry.binding)})`),
  );
  if (others.length > 0)
    throw cloudflareUsage(
      `${state.workerName} is still bound at ${others.join(", ")} in ${state.appConfigPath}, outside the recorded ${SERVICE_BINDING} binding at ${recorded}; delete those bindings, then rerun splitch cloudflare remove`,
    );
  const recordedEntry = serviceLists(document)
    .find(({ path }) => path === recorded)
    ?.services.find((entry) => isRecord(entry) && entry.binding === SERVICE_BINDING);
  if (isRecord(recordedEntry) && recordedEntry.service !== state.workerName)
    throw cloudflareUsage(
      `${SERVICE_BINDING} no longer points to ${state.workerName}; refusing to remove it`,
    );
  return name === undefined || hasWranglerEnvironment(document, name);
}

function serviceLists(document: Record<string, unknown>) {
  const environments = isRecord(document.env) ? Object.keys(document.env) : [];
  return [["services"], ...environments.map((name) => ["env", name, "services"])].flatMap(
    (path) => {
      const services = valueAtPath(document, path);
      return Array.isArray(services) ? [{ path: path.join("."), services }] : [];
    },
  );
}

/**
 * Without an explicit `wranglerEnvironment` the splitch Environment key doubles
 * as the Wrangler environment name, and a config with no `env` block binds at
 * the top level. An explicit name must exist; it never falls back to the top level.
 */
export async function serviceBindingPath(
  configPath: string,
  environment: string,
  wranglerEnvironment?: string,
): Promise<readonly string[]> {
  const document = await readConfig(configPath);
  if (!isRecord(document.env) && wranglerEnvironment === undefined) return ["services"];
  const name = wranglerEnvironment ?? environment;
  if (hasWranglerEnvironment(document, name)) return ["env", name, "services"];
  throw cloudflareUsage(
    `Wrangler Environment ${JSON.stringify(name)} does not exist in ${configPath}`,
  );
}

// Own keys only: `__proto__` would otherwise read Object.prototype as an existing environment.
function hasWranglerEnvironment(document: Record<string, unknown>, name: string): boolean {
  return (
    isRecord(document.env) && Object.hasOwn(document.env, name) && isRecord(document.env[name])
  );
}

export function recordedWranglerEnvironment(state: CloudflareState): string | undefined {
  const [scope, name, leaf] = state.appBindingPath;
  // JSON parsing turns a `__proto__` key into the prototype, so no Wrangler environment has that name.
  return state.appBindingPath.length === 3 &&
    scope === "env" &&
    leaf === "services" &&
    name !== "__proto__"
    ? name
    : undefined;
}

function isTopLevelBinding(state: CloudflareState): boolean {
  return state.appBindingPath.length === 1 && state.appBindingPath[0] === "services";
}

export async function assertRecordedBindingPath(state: CloudflareState): Promise<void> {
  const document = await readConfig(state.appConfigPath);
  const name = recordedWranglerEnvironment(state);
  const current =
    name === undefined
      ? isTopLevelBinding(state) && !isRecord(document.env)
      : hasWranglerEnvironment(document, name);
  if (current) return;
  throw cloudflareUsage(
    `The ${state.environment} integration binds ${SERVICE_BINDING} at ${state.appBindingPath.join(".")}, which no longer matches ${state.appConfigPath}; run splitch cloudflare remove --env ${state.environment}, then rerun setup`,
  );
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

async function readConfig(path: string): Promise<Record<string, unknown>> {
  return parseJsonc(await readFile(path, "utf8"), path) as Record<string, unknown>;
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

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
