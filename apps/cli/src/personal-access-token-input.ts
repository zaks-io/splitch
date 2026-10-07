import { SplitchCliError } from "./errors.js";
import type { ParsedGlobalFlags } from "./parse-args.js";

export const PERSONAL_ACCESS_TOKEN_OPERATIONS: ReadonlySet<string> = new Set([
  "personal_access_tokens_list",
  "personal_access_tokens_create",
  "personal_access_tokens_update",
  "personal_access_tokens_rotate",
  "personal_access_tokens_revoke",
  "personal_access_tokens_revoke_all",
]);

/** The two operations whose response carries a once-only secret. */
export function returnsPersonalAccessTokenSecret(operationId: string): boolean {
  return (
    operationId === "personal_access_tokens_create" ||
    operationId === "personal_access_tokens_rotate"
  );
}

const ROLES = new Set(["member", "admin", "owner"]);
const ACCESS = new Set(["read", "read-write"]);
const DAY_MS = 24 * 60 * 60 * 1000;
const GRANT_EXAMPLE = "--grant app:app_123:admin:read-write, --grant all:member:read";

/**
 * Fold `--grant` and `--expires-at` into a `tokens create|update` body. A grant
 * is `<target>:<role>:<access>` with `<target>` one of `all`, `org:<org id>`,
 * `app:<app id>`. `--expires-at` takes `never`, a day count like `90d`, or an
 * ISO 8601 date or date-time. Omitting it on create keeps the 90-day default;
 * `never` is the only way to ask for a token that does not expire.
 */
export function applyPersonalAccessTokenFields(
  operationId: string,
  flags: ParsedGlobalFlags,
  input: Record<string, unknown>,
  nowMs: number = Date.now(),
): void {
  if (
    operationId !== "personal_access_tokens_create" &&
    operationId !== "personal_access_tokens_update"
  ) {
    return;
  }
  if (flags.grant.length > 0) input.grants = flags.grant.map(parseGrant);
  if (flags.expiresAt !== undefined) input.expiresAt = parseExpiry(flags.expiresAt, nowMs);
  if (operationId !== "personal_access_tokens_create") return;
  if (typeof input.name !== "string" || input.name.length === 0) {
    throw usage("splitch tokens create requires --name", "Name the token, e.g. --name sandboxes");
  }
  if (!Array.isArray(input.grants) || input.grants.length === 0) {
    throw usage(
      "splitch tokens create requires at least one --grant",
      `Grant what the token may reach, e.g. ${GRANT_EXAMPLE}`,
    );
  }
}

function parseGrant(value: string): { target: string; role: string; access: string } {
  const parts = value.split(":");
  const access = parts.pop() ?? "";
  const role = parts.pop() ?? "";
  const target = parts.join(":");
  const targetOk = target === "all" || /^(org|app):[^:]+$/.test(target);
  if (!targetOk || !ROLES.has(role) || !ACCESS.has(access)) {
    throw usage(
      `--grant ${value} is not <target>:<role>:<access>`,
      `Use a target of all, org:<org id>, or app:<app id>; a role of member, admin, or owner; and access read or read-write (${GRANT_EXAMPLE})`,
    );
  }
  return { target, role, access };
}

function parseExpiry(value: string, nowMs: number): string | null {
  if (value === "never") return null;
  const days = /^(\d{1,5})d$/.exec(value);
  if (days) return new Date(nowMs + Number(days[1]) * DAY_MS).toISOString();
  const parsed = Date.parse(value);
  if (/^\d{4}-\d{2}-\d{2}/.test(value) && Number.isFinite(parsed)) {
    return new Date(parsed).toISOString();
  }
  throw usage(
    `--expires-at ${value} is not a date, a day count, or never`,
    "Pass never, a day count like 90d, or an ISO 8601 date such as 2027-01-01",
  );
}

function usage(causeSummary: string, remediation: string): SplitchCliError {
  return new SplitchCliError({ code: "CLI_USAGE_INVALID", causeSummary, remediation });
}
