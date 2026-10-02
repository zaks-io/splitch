import { z } from "zod";
import type { StoredFlagLifecycleClass } from "./leaf-schemas-flag";

/**
 * The D9 rule, shared by the Control Plane Worker and the Control Panel form so
 * both refuse the same Flag. Release and experiment Flags are temporary by
 * definition, so they must name who removes them and when. Ops and permission
 * Flags are intentionally permanent and may omit both.
 */
const FLAG_LIFECYCLE_CLASSES_REQUIRING_OWNER_AND_EXPIRY = ["release", "experiment"] as const;

export type FlagLifecycleInput = "owner" | "expiresAt";

export function missingFlagLifecycleInputs(lifecycle: {
  lifecycleClass: StoredFlagLifecycleClass;
  owner: string | null | undefined;
  expiresAt: string | null | undefined;
}): FlagLifecycleInput[] {
  const requiresBoth = (
    FLAG_LIFECYCLE_CLASSES_REQUIRING_OWNER_AND_EXPIRY as readonly string[]
  ).includes(lifecycle.lifecycleClass);
  if (!requiresBoth) return [];
  const missing: FlagLifecycleInput[] = [];
  if (!lifecycle.owner) missing.push("owner");
  if (!lifecycle.expiresAt) missing.push("expiresAt");
  return missing;
}

/** The `FLAG_LIFECYCLE_INCOMPLETE` error member, assembled into the union in errors.ts. */
export const flagLifecycleErrorMembers = [
  z.object({
    code: z.literal("FLAG_LIFECYCLE_INCOMPLETE"),
    message: z.string(),
    details: z
      .object({
        lifecycleClass: z.string(),
        missing: z.array(z.enum(["owner", "expiresAt"])).min(1),
      })
      .strict(),
  }),
] as const;
