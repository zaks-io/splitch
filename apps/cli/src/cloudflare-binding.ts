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

export async function assertServiceBindingRemovable(state: CloudflareState): Promise<void> {
  const { services } = await serviceBindingState(state);
  const existing = services.find((entry) => isRecord(entry) && entry.binding === SERVICE_BINDING) as
    | Record<string, unknown>
    | undefined;
  if (existing && existing.service !== state.workerName) {
    throw cloudflareUsage(
      `${SERVICE_BINDING} no longer points to ${state.workerName}; refusing to remove it`,
    );
  }
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
  const raw = await readFile(configPath, "utf8");
  const document = parseJsonc(raw, configPath) as Record<string, unknown>;
  const environments = isRecord(document.env) ? document.env : undefined;
  if (!environments && wranglerEnvironment === undefined) return ["services"];
  const name = wranglerEnvironment ?? environment;
  // Own keys only: `__proto__` would otherwise read Object.prototype as an existing environment.
  if (environments && Object.hasOwn(environments, name) && isRecord(environments[name]))
    return ["env", name, "services"];
  throw cloudflareUsage(
    `Wrangler Environment ${JSON.stringify(name)} does not exist in ${configPath}`,
  );
}

export function recordedWranglerEnvironment(state: CloudflareState): string | undefined {
  const [scope, name, leaf] = state.appBindingPath;
  return state.appBindingPath.length === 3 && scope === "env" && leaf === "services"
    ? name
    : undefined;
}

export async function assertRecordedBindingPath(
  configPath: string,
  environment: string,
  state: CloudflareState,
): Promise<void> {
  const expected = await serviceBindingPath(
    configPath,
    environment,
    recordedWranglerEnvironment(state),
  );
  if (
    state.appBindingPath.length !== expected.length ||
    state.appBindingPath.some((part, index) => part !== expected[index])
  ) {
    throw cloudflareUsage(`Cloudflare state points at an unexpected service binding`);
  }
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
