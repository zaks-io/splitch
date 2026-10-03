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

/** Who is writing and when, so an omitted owner or expiry can be filled. */
export interface LifecycleDefaults {
  owner: string;
  now: string;
}

const DEFAULT_LIFECYCLE_CLASS: FlagLifecycleClass = "release";
const DAY_MS = 24 * 60 * 60 * 1000;
// Only the temporary classes get a default lifetime; ops and permission Flags
// are permanent by design (D9).
const DEFAULT_EXPIRY_DAYS: Partial<Record<StoredFlagLifecycleClass, number>> = {
  release: 90,
  experiment: 30,
};

/**
 * The lifecycle a create writes. Nothing is required: an agent that names no
 * class gets a release Flag owned by the caller that expires in 90 days, so
 * stale detection still has an owner and a date to act on.
 */
export function createLifecycle(
  body: Record<string, unknown>,
  defaults: LifecycleDefaults,
): FlagLifecycle & { lifecycleClass: FlagLifecycleClass } {
  const lifecycleClass =
    (body.lifecycleClass as FlagLifecycleClass | undefined) ?? DEFAULT_LIFECYCLE_CLASS;
  const temporary = lifecycleClass in DEFAULT_EXPIRY_DAYS;
  return {
    lifecycleClass,
    owner: (body.owner as string | undefined) ?? (temporary ? defaults.owner : null),
    expiresAt: utcExpiry(body.expiresAt) ?? defaultExpiry(lifecycleClass, defaults.now),
  };
}

/**
 * The lifecycle columns a patch writes, or `undefined` when the patch names
 * none. Reclassifying to a temporary class fills an owner or expiry the patch
 * does not mention. An explicit `null` is a request to clear, so clearing what
 * a temporary class needs is still refused against the merged result.
 */
export function patchLifecycle(
  current: FlagLifecycle,
  body: Record<string, unknown>,
  defaults: LifecycleDefaults,
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
  const merged = { ...current, ...patch };
  for (const missing of missingFlagLifecycleInputs(merged)) {
    if (body[missing] !== undefined) continue;
    patch[missing] =
      missing === "owner" ? defaults.owner : defaultExpiry(merged.lifecycleClass, defaults.now);
  }
  const checked = checkLifecycle({ ...current, ...patch }, requestId);
  return checked.ok ? ok(patch) : checked;
}

function checkLifecycle<T extends FlagLifecycle>(lifecycle: T, requestId: string): Result<T> {
  const missing = missingFlagLifecycleInputs(lifecycle);
  if (missing.length === 0) return ok(lifecycle);
  return fail(flagLifecycleIncomplete(requestId, lifecycle.lifecycleClass, missing));
}

function defaultExpiry(lifecycleClass: StoredFlagLifecycleClass, now: string): string | null {
  const days = DEFAULT_EXPIRY_DAYS[lifecycleClass];
  if (days === undefined) return null;
  return new Date(Date.parse(now) + days * DAY_MS).toISOString();
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
      message: `a ${lifecycleClass}-class Flag cannot clear its ${missing.join(" and ")}`,
      details: { lifecycleClass, missing },
    },
    { requestId },
  );
}
