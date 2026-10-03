import { SplitchCliError } from "./errors.js";
import type { ParsedGlobalFlags } from "./parse-args.js";

const LIFECYCLE_OPERATIONS = new Set(["flags_create", "flags_update"]);

/**
 * `--lifecycle-class`, `--owner`, and `--expires-at` (D9). Values pass through
 * unchanged so the shared contract and the Worker stay the only judges of what
 * a class requires. On `flags update`, `none` clears an owner or expiry; the
 * Worker refuses the clear when the Flag's class needs the value.
 */
export function applyFlagLifecycleFlags(
  operationId: string,
  flags: ParsedGlobalFlags,
  input: Record<string, unknown>,
): void {
  const given = {
    lifecycleClass: flags.lifecycleClass,
    owner: flags.owner,
    expiresAt: flags.expiresAt,
  };
  const present = Object.entries(given).filter(([, value]) => value !== undefined);
  if (present.length === 0) return;
  if (!LIFECYCLE_OPERATIONS.has(operationId)) {
    throw new SplitchCliError({
      code: "CLI_USAGE_INVALID",
      causeSummary:
        "--lifecycle-class, --owner, and --expires-at apply only to flags create and flags update",
      remediation:
        "Drop those flags, or run them with splitch flags create or splitch flags update",
    });
  }
  const clearable = operationId === "flags_update";
  if (
    !clearable &&
    present.some(([field, value]) => field !== "lifecycleClass" && value === "none")
  ) {
    throw new SplitchCliError({
      code: "CLI_USAGE_INVALID",
      causeSummary: "none clears an owner or expiry and only applies to flags update",
      remediation: "Name the owner and expiry, or choose the ops or permission class",
    });
  }
  for (const [field, value] of present) {
    input[field] = clearable && field !== "lifecycleClass" && value === "none" ? null : value;
  }
}
