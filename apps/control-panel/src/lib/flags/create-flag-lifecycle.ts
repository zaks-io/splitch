import {
  type FlagLifecycleClass,
  flagLifecycleClasses,
  missingFlagLifecycleInputs,
} from "@splitch/contracts";
import { z } from "zod";

/**
 * The lifecycle part of the Create Flag draft (D9). The class starts unchosen
 * rather than preset: the point of the field is that someone decides why the
 * Flag exists, and a preselected answer would record a decision nobody made.
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
  if (draft.lifecycleClass === "") {
    return [{ path: "lifecycleClass", message: "Choose why this Flag exists." }];
  }
  const issues: { path: string; message: string }[] = [];
  if (draft.expiresOn !== "" && !EXPIRES_ON_PATTERN.test(draft.expiresOn)) {
    issues.push({ path: "expiresAt", message: "Enter a date." });
  }
  const missing = missingFlagLifecycleInputs({
    lifecycleClass: draft.lifecycleClass,
    owner: draft.owner.trim(),
    expiresAt: draft.expiresOn,
  });
  for (const field of missing) {
    issues.push({
      path: field,
      message:
        field === "owner"
          ? `A ${draft.lifecycleClass} Flag needs an owner.`
          : `A ${draft.lifecycleClass} Flag needs an expiry date.`,
    });
  }
  return issues;
}

/** The `flags_create` lifecycle fields. Callers check `lifecycleIssues` first. */
export function lifecycleCreateFields(draft: LifecycleDraft): {
  lifecycleClass: FlagLifecycleClass;
  owner?: string;
  expiresAt?: string;
} {
  if (draft.lifecycleClass === "") {
    throw new Error("create-flag-lifecycle: refusing to build a Flag with no lifecycle class");
  }
  const owner = draft.owner.trim();
  return {
    lifecycleClass: draft.lifecycleClass,
    ...(owner === "" ? {} : { owner }),
    ...(draft.expiresOn === "" ? {} : { expiresAt: `${draft.expiresOn}T00:00:00.000Z` }),
  };
}
