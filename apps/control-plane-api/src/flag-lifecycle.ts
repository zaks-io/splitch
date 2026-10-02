import {
  type FlagLifecycleClass,
  type FlagLifecycleInput,
  missingFlagLifecycleInputs,
  type StoredFlagLifecycleClass,
} from "@splitch/contracts";
import { renderError } from "@splitch/worker-runtime";
import { fail, ok, type Result } from "./flag-definition-handler-utils";

/** The lifecycle columns of a Flag row, as stored. */
export interface FlagLifecycle {
  lifecycleClass: StoredFlagLifecycleClass;
  owner: string | null;
  expiresAt: string | null;
}

/**
 * The lifecycle a create writes. The body already passed the contract, so the
 * class is present; this applies the class-dependent D9 rule the schema cannot
 * express without hiding which input is missing.
 */
export function createLifecycle(
  body: Record<string, unknown>,
  requestId: string,
): Result<FlagLifecycle & { lifecycleClass: FlagLifecycleClass }> {
  const lifecycleClass = body.lifecycleClass as FlagLifecycleClass | undefined;
  if (!lifecycleClass) throw new Error("flags_create reached the handler without lifecycleClass");
  const lifecycle = {
    lifecycleClass,
    owner: (body.owner as string | undefined) ?? null,
    expiresAt: utcExpiry(body.expiresAt),
  };
  return checked(lifecycle, requestId);
}

/**
 * The lifecycle columns a patch writes, or `undefined` when the patch names
 * none. The rule is checked against the merged result, so classifying a legacy
 * Flag as `release` without also naming its owner and expiry is refused, and so
 * is clearing the expiry of a Flag that is already `release`.
 */
export function patchLifecycle(
  current: FlagLifecycle,
  body: Record<string, unknown>,
  requestId: string,
): Result<Partial<FlagLifecycle> | undefined> {
  const touched = ["lifecycleClass", "owner", "expiresAt"].some((field) => field in body);
  if (!touched) return ok(undefined);
  const patch: Partial<FlagLifecycle> = {
    ...(body.lifecycleClass !== undefined
      ? { lifecycleClass: body.lifecycleClass as FlagLifecycleClass }
      : {}),
    ...(body.owner !== undefined ? { owner: body.owner as string | null } : {}),
    ...(body.expiresAt !== undefined ? { expiresAt: utcExpiry(body.expiresAt) } : {}),
  };
  const merged = checked({ ...current, ...patch }, requestId);
  return merged.ok ? ok(patch) : merged;
}

function checked<T extends FlagLifecycle>(lifecycle: T, requestId: string): Result<T> {
  const missing = missingFlagLifecycleInputs(lifecycle);
  if (missing.length === 0) return ok(lifecycle);
  return fail(flagLifecycleIncomplete(requestId, lifecycle.lifecycleClass, missing));
}

/**
 * Stored as UTC `toISOString()` so the expired-Flag read can compare text: an
 * offset or a missing fraction would sort out of chronological order.
 */
function utcExpiry(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const parsed = new Date(value as string);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error("expiresAt passed the contract but is not a parseable date-time");
  }
  return parsed.toISOString();
}

function flagLifecycleIncomplete(
  requestId: string,
  lifecycleClass: StoredFlagLifecycleClass,
  missing: FlagLifecycleInput[],
): Response {
  return renderError(
    {
      code: "FLAG_LIFECYCLE_INCOMPLETE",
      message: `a ${lifecycleClass}-class Flag requires ${missing.join(" and ")}`,
      details: { lifecycleClass, missing },
    },
    { requestId },
  );
}
