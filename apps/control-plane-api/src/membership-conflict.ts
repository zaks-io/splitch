import type { UserRole } from "@splitch/contracts";
import { renderError } from "@splitch/worker-runtime";

export function membershipConflict(
  existingRole: UserRole,
  resource: "app" | "organization",
  requestId: string,
): Response {
  const memberKind = resource === "app" ? "an App member" : "an organization member";
  return renderError(
    {
      code: "MEMBERSHIP_CONFLICT",
      message: `user is already ${memberKind}`,
      details: { existingRole },
    },
    { requestId },
  );
}
