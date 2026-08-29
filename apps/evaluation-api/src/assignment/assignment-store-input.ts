import type { HashedAssignmentPutInput } from "./assignment-store";

export function parseHashedAssignmentPut(value: unknown): HashedAssignmentPutInput & {
  readonly identityVersion: string;
} {
  if (!isRecord(value)) throw new TypeError("assignment-store: expected object payload");
  const input = {
    appId: requireString(value, "appId"),
    experimentId: requireString(value, "experimentId"),
    idType: requireString(value, "idType"),
    targetingKeyHash: requireString(value, "targetingKeyHash"),
    identityVersion: requireString(value, "identityVersion"),
    runId: requireString(value, "runId"),
    variant: requireString(value, "variant"),
  };
  const extra = Object.keys(value).filter((key) => !(key in input));
  if (extra.length > 0) {
    throw new TypeError(`assignment-store: unexpected payload keys ${extra.join(",")}`);
  }
  return input;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  if (typeof field !== "string" || field.length === 0) {
    throw new TypeError(`assignment-store: ${key} must be a non-empty string`);
  }
  return field;
}
