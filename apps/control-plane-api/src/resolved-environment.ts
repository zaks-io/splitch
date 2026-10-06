import type { EnvironmentRow } from "./app-environment-model";

// Parsed input identity carries trusted resolver data without exposing it in the
// public request schema or accepting a row supplied by the caller.
const resolvedEnvironments = new WeakMap<object, EnvironmentRow | null>();

export function recordResolvedEnvironment(input: unknown, row: EnvironmentRow | null): void {
  if (!input || typeof input !== "object") {
    throw new Error("Environment resolver received non-object parsed input");
  }
  resolvedEnvironments.set(input, row);
}

export function resolvedEnvironment(
  input: unknown,
  appId: string,
  environmentId: string,
): EnvironmentRow | null | undefined {
  if (!input || typeof input !== "object") return undefined;
  const row = resolvedEnvironments.get(input);
  if (row && (row.appId !== appId || row.id !== environmentId)) {
    throw new Error("Resolved Environment does not match canonical request scope");
  }
  return row;
}
