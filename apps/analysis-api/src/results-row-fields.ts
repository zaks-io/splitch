import { ResultsForbiddenError } from "./results-errors";

/**
 * Field readers for Tinybird rows and request payloads.
 *
 * Every reader throws on a shape it did not expect. A row that quietly
 * defaulted a missing field would flow into the stats engine as a real number.
 */

export function rowObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("analysis-api: expected object");
  }
  return value as Record<string, unknown>;
}

export function optionalObject(value: unknown): Record<string, unknown> {
  return value === undefined ? {} : rowObject(value);
}

export function stringField(source: Record<string, unknown>, key: string): string {
  const value = source[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`analysis-api: missing ${key}`);
  }
  return value;
}

export function requiredPrincipalContext(value: string | null): string {
  if (value === null || value.trim().length === 0) {
    throw new ResultsForbiddenError("credential is not scoped to this app");
  }
  return value;
}

export function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

export function booleanField(source: Record<string, unknown>, key: string): boolean {
  const value = source[key];
  if (value === true || value === false) return value;
  if (value === 1) return true;
  if (value === 0) return false;
  throw new Error(`analysis-api: missing ${key}`);
}

export function jsonField(source: Record<string, unknown>, key: string): unknown {
  const value = source[key];
  if (typeof value !== "string") {
    return value;
  }
  return JSON.parse(value) as unknown;
}

export function compact<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter((entry) => entry[1] !== undefined),
  ) as Partial<T>;
}
