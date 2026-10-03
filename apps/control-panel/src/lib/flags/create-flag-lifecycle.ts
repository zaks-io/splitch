import { type FlagLifecycleClass, flagLifecycleClasses } from "@splitch/contracts";
import { z } from "zod";

/**
 * The lifecycle part of the Create Flag draft (D9). Every field is optional:
 * blank inputs are left out of the request so the Worker applies the same
 * defaults an agent gets (release, owned by the caller, 90 or 30 days out).
 */
export const LifecycleDraftShape = {
  lifecycleClass: z.union([z.enum(flagLifecycleClasses), z.literal("")]),
  owner: z.string(),
  /** `YYYY-MM-DD` from a date input; the Flag expires at 00:00 UTC that day. */
  expiresOn: z.string(),
};

export type LifecycleDraft = {
  lifecycleClass: FlagLifecycleClass | "";
  owner: string;
  expiresOn: string;
};

export const emptyLifecycleDraft: LifecycleDraft = { lifecycleClass: "", owner: "", expiresOn: "" };

const EXPIRES_ON_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function lifecycleIssues(draft: LifecycleDraft): { path: string; message: string }[] {
  if (draft.expiresOn !== "" && !EXPIRES_ON_PATTERN.test(draft.expiresOn)) {
    return [{ path: "expiresAt", message: "Enter a date." }];
  }
  return [];
}

/** The `flags_create` lifecycle fields the user filled in. */
export function lifecycleCreateFields(draft: LifecycleDraft): {
  lifecycleClass?: FlagLifecycleClass;
  owner?: string;
  expiresAt?: string;
} {
  const owner = draft.owner.trim();
  return {
    ...(draft.lifecycleClass === "" ? {} : { lifecycleClass: draft.lifecycleClass }),
    ...(owner === "" ? {} : { owner }),
    ...(draft.expiresOn === "" ? {} : { expiresAt: `${draft.expiresOn}T00:00:00.000Z` }),
  };
}
