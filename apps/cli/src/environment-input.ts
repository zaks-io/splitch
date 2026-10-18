import { z } from "zod";
import { SplitchCliError } from "./errors.js";
import { parseExpiry } from "./expiry-input.js";
import type { ParsedGlobalFlags } from "./parse-args.js";

export function applyEnvironmentFields(
  operationId: string,
  flags: ParsedGlobalFlags,
  input: Record<string, unknown>,
  nowMs: number = Date.now(),
): void {
  assertEnvironmentFlags(operationId, flags);
  if (operationId === "environments_sync") {
    if (flags.from !== undefined) input.fromEnvironmentId = flags.from;
    requireSource(input.fromEnvironmentId, "envs sync");
    return;
  }
  if (operationId !== "environments_create") return;
  if (!flags.temporary && flags.from === undefined && flags.expiresAt === undefined) return;

  const temporary = temporaryBody(input.temporary, flags.temporary === true);
  if (flags.from !== undefined) temporary.fromEnvironmentId = flags.from;
  requireSource(temporary.fromEnvironmentId, "envs create --temporary");
  if (flags.expiresAt !== undefined) {
    temporary.expiresAt = parseTemporaryExpiry(flags.expiresAt, nowMs);
  }
  input.temporary = temporary;
}

function assertEnvironmentFlags(operationId: string, flags: ParsedGlobalFlags): void {
  if (flags.temporary && operationId !== "environments_create") {
    throw usage("--temporary applies only to envs create", "Use splitch envs create --temporary");
  }
}

function temporaryBody(existing: unknown, temporaryFlag: boolean): Record<string, unknown> {
  if (!temporaryFlag && existing === undefined) {
    throw usage("--from and --expires-at require a Temporary Environment", "Add --temporary");
  }
  if (
    existing !== undefined &&
    (typeof existing !== "object" || existing === null || Array.isArray(existing))
  ) {
    throw usage("temporary must be an object", "Pass temporary.fromEnvironmentId in --body-json");
  }
  return existing === undefined ? {} : { ...(existing as Record<string, unknown>) };
}

function parseTemporaryExpiry(value: string, nowMs: number): string {
  if (!/^\d{1,5}d$/.test(value) && !z.iso.datetime({ offset: true }).safeParse(value).success) {
    throw usage(
      "Temporary Environment expiry must be a day count or ISO 8601 instant with an offset",
      "Pass --expires-at 3d or --expires-at 2027-01-01T12:00:00Z; expiry cannot be never",
    );
  }
  const expiry = parseExpiry(value, nowMs);
  if (expiry === null) throw new Error("Temporary Environment expiry cannot be null");
  const remainingMs = Date.parse(expiry) - nowMs;
  if (remainingMs <= 60_000 || remainingMs > 7 * 24 * 60 * 60 * 1000) {
    throw usage(
      "Temporary Environment expiry must be more than one minute and at most seven days out",
      "Pass --expires-at 3d or an ISO 8601 instant within seven days",
    );
  }
  return expiry;
}

function requireSource(value: unknown, command: string): void {
  if (typeof value === "string" && value.length > 0) return;
  throw usage(`${command} requires a source Environment`, "Pass --from <environment>");
}

function usage(causeSummary: string, remediation: string): SplitchCliError {
  return new SplitchCliError({ code: "CLI_USAGE_INVALID", causeSummary, remediation });
}
