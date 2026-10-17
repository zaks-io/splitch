import { renderError } from "@splitch/worker-runtime";

export function environmentCreateConflict(
  cause: unknown,
  key: string,
  requestId: string,
): Response {
  // Drizzle wraps D1 errors. Match the reported columns rather than SQLite's index name.
  let current = cause;
  while (current instanceof Error) {
    if (
      /UNIQUE constraint failed: environments\.app_id, environments\.key(?:\b|$)/.test(
        current.message,
      )
    ) {
      return renderError(
        {
          code: "SLUG_CONFLICT",
          message: `Environment key "${key}" is already taken in this App`,
          details: {
            resourceType: "environment",
            conflictingSlug: key,
            recommendedAction: "CHOOSE_DIFFERENT_SLUG",
          },
        },
        { requestId },
      );
    }
    current = current.cause;
  }
  throw cause;
}
