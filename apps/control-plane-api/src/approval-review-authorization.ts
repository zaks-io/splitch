import {
  type NarrowOutcome,
  narrowPersonalAccessTokenForOperation,
  narrowPersonalAccessTokenForPermission,
} from "@splitch/worker-runtime";
import type { ReviewApprovalInput } from "./approval-service-types";

/** Stored proposals bypass their original route guard when applied. */
export function narrowApprovalReviewPrincipal(
  input: Pick<ReviewApprovalInput, "action" | "principal" | "appId">,
  operation: string,
): NarrowOutcome {
  const params = { appId: input.appId };
  return input.action === "decline"
    ? narrowPersonalAccessTokenForPermission("write", input.principal, params, {
        targeted: true,
      })
    : narrowPersonalAccessTokenForOperation(operation, input.principal, params);
}
