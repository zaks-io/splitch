// The contract's slug rule verbatim, so this form cannot accept a key the API
// then rejects (or reject one it would have taken).
import { SLUG_MAX_LENGTH, SLUG_MIN_LENGTH, SLUG_PATTERN } from "@splitch/contracts";

export interface CreateAppDraft {
  readonly name: string;
  readonly key: string;
}

export interface CreateAppIssue {
  readonly path: "name" | "key";
  readonly message: string;
}

export const emptyAppDraft: CreateAppDraft = { name: "", key: "" };

export function draftAppIssues(draft: CreateAppDraft): CreateAppIssue[] {
  const issues: CreateAppIssue[] = [];
  if (draft.name.trim().length === 0) {
    issues.push({ path: "name", message: "Give the App a name." });
  }
  const key = draft.key.trim();
  if (key.length === 0) {
    issues.push({ path: "key", message: "Give the App a URL slug." });
  } else if (!SLUG_PATTERN.test(key)) {
    issues.push({
      path: "key",
      message: "Use lowercase letters, digits, and single hyphens, e.g. checkout-api.",
    });
  } else if (key.length < SLUG_MIN_LENGTH || key.length > SLUG_MAX_LENGTH) {
    issues.push({
      path: "key",
      message: `Use between ${SLUG_MIN_LENGTH} and ${SLUG_MAX_LENGTH} characters.`,
    });
  }
  return issues;
}

export function appIssueFor(
  issues: readonly CreateAppIssue[],
  path: CreateAppIssue["path"],
): string | undefined {
  return issues.find((issue) => issue.path === path)?.message;
}

/** Suggests the slug from the name until the operator edits the slug themselves. */
export function suggestAppKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
