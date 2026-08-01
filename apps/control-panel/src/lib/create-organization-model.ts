import {
  deriveOrganizationSlug,
  isReservedOrganizationSlug,
  SLUG_MAX_LENGTH,
  SLUG_MIN_LENGTH,
  SLUG_PATTERN,
} from "@splitch/contracts";

export interface CreateOrganizationDraft {
  readonly name: string;
  readonly slug: string;
}

export interface CreateOrganizationIssue {
  readonly path: "name" | "slug";
  readonly message: string;
}

export const emptyOrganizationDraft: CreateOrganizationDraft = { name: "", slug: "" };

/**
 * Client-side parity with `OrganizationSlugSchema`, so the same handle the Worker
 * would reject is named before a round trip. The Worker stays authoritative: this
 * only ever refuses, it never rewrites what the user typed.
 */
export function draftOrganizationIssues(draft: CreateOrganizationDraft): CreateOrganizationIssue[] {
  const issues: CreateOrganizationIssue[] = [];
  if (draft.name.trim().length === 0) {
    issues.push({ path: "name", message: "Give the Organization a name." });
  }
  const slug = draft.slug.trim();
  if (slug.length === 0) {
    issues.push({ path: "slug", message: "Give the Organization a URL handle." });
  } else if (slug.length < SLUG_MIN_LENGTH) {
    issues.push({
      path: "slug",
      message: `Use at least ${SLUG_MIN_LENGTH} characters.`,
    });
  } else if (slug.length > SLUG_MAX_LENGTH) {
    issues.push({
      path: "slug",
      message: `Use at most ${SLUG_MAX_LENGTH} characters.`,
    });
  } else if (!SLUG_PATTERN.test(slug)) {
    issues.push({
      path: "slug",
      message: "Use lowercase letters, digits, and single hyphens, e.g. acme-labs.",
    });
  } else if (isReservedOrganizationSlug(slug)) {
    issues.push({
      path: "slug",
      message: `"${slug}" is reserved by splitch. Pick another handle.`,
    });
  }
  return issues;
}

export function organizationIssueFor(
  issues: readonly CreateOrganizationIssue[],
  path: CreateOrganizationIssue["path"],
): string | undefined {
  return issues.find((issue) => issue.path === path)?.message;
}

/**
 * Suggests a handle from the name, and only until the user edits the handle
 * themselves. The suggestion is always visible and always editable: what is
 * submitted is exactly what the field shows, never a silently corrected variant
 * of it.
 */
export function suggestOrganizationSlug(name: string): string {
  return deriveOrganizationSlug(name) ?? "";
}
