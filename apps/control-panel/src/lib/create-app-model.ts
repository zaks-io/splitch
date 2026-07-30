export interface CreateAppDraft {
  readonly name: string;
  readonly key: string;
}

export interface CreateAppIssue {
  readonly path: "name" | "key";
  readonly message: string;
}

/** Slugs are the human/agent-readable URL handle, so the same shape the CLI accepts. */
const KEY_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const emptyAppDraft: CreateAppDraft = { name: "", key: "" };

export function draftAppIssues(draft: CreateAppDraft): CreateAppIssue[] {
  const issues: CreateAppIssue[] = [];
  if (draft.name.trim().length === 0) {
    issues.push({ path: "name", message: "Give the App a name." });
  }
  const key = draft.key.trim();
  if (key.length === 0) {
    issues.push({ path: "key", message: "Give the App a URL slug." });
  } else if (!KEY_PATTERN.test(key)) {
    issues.push({
      path: "key",
      message: "Use lowercase letters, digits, and single hyphens, e.g. checkout-api.",
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
