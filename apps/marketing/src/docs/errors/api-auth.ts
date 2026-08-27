import type { ErrorDoc } from "./types";

export const authErrorDocs = {
  UNAUTHORIZED: {
    remediation:
      "Send a credential: a Client Key to evaluate, or an API Key to read or write the control plane",
    cause: "No valid credential was presented, or the one presented could not be parsed.",
    fix: "Send a credential. A Client Key (`pk_…` key material) evaluates; an API Key (`sk_…`) reads and writes the control plane. At the CLI, run `splitch login`.",
    related: ["CREDENTIAL_REVOKED", "INSUFFICIENT_SCOPES", "FORBIDDEN"],
  },
  CREDENTIAL_REVOKED: {
    remediation: "Mint a replacement key and roll it out",
    cause: "The credential is well-formed and known, but has been revoked.",
    fix: "Mint a replacement key and roll it out. Revocation is immediate and deliberate: a revoked key never degrades into read-only or cached service.",
    related: ["UNAUTHORIZED", "CREDENTIAL_NOT_FOUND"],
  },
  INSUFFICIENT_SCOPES: {
    remediation: "Use a credential holding the scopes in details.requiredScopes",
    cause: "The credential is valid but does not carry the scopes this operation requires.",
    fix: "Compare `details.requiredScopes` with `details.heldScopes` and use a credential that holds the difference. A Client Key holds only `evaluate` by construction, so control-plane operations need an API Key.",
    details: "{ requiredScopes: string[], heldScopes: string[] }",
    related: ["FORBIDDEN", "UNAUTHORIZED", "APP_MISMATCH"],
  },
  FORBIDDEN: {
    remediation: "Use a principal with the required Organization role, or have an owner grant it",
    cause:
      "The principal is authenticated but is not authorized for this resource under its Organization role.",
    fix: "Use a principal with the required role, or have an owner grant it. This is a membership decision, not a scope one; INSUFFICIENT_SCOPES covers the credential side.",
    related: ["INSUFFICIENT_SCOPES", "LAST_OWNER_REQUIRED", "APPROVAL_REVIEW_FORBIDDEN"],
  },
  ORIGIN_NOT_ALLOWED: {
    remediation: "Add details.origin to the Client Key's allow-list, or open the key",
    cause: "A valid Client Key was presented from an origin that is not on that key's allow-list.",
    fix: "Add the origin in `details.origin` to the key's allow-list, or open the key. `details.hint` names the specific next step for the key's current state.",
    details: "{ origin: string, hint: string }",
    related: ["APP_MISMATCH", "UNAUTHORIZED"],
  },
  APP_MISMATCH: {
    remediation: "Use the credential minted for this App and Environment",
    cause: "The credential belongs to a different App than the one the request addressed.",
    fix: "Fetch the credential for this App and Environment and use that. Keys are bound to one App: a key from a sibling Environment is a different key, not a broader one.",
    related: ["ORIGIN_NOT_ALLOWED", "APP_NOT_FOUND", "INSUFFICIENT_SCOPES"],
  },
  LAST_OWNER_REQUIRED: {
    remediation: "Promote another member to owner first, then retry",
    cause:
      "The change would leave a shared Organization with no owner, which would strand every member without an escalation path.",
    fix: "Promote another member to owner first, then retry the removal or role change.",
    details: "{ orgId: string }",
    related: ["FORBIDDEN", "ORGANIZATION_NOT_FOUND"],
  },
  LAST_ENVIRONMENT_REQUIRED: {
    remediation: "Create a replacement Environment first, or delete the App instead",
    cause:
      "The delete would leave an App with no Environment, and an App cannot serve without one.",
    fix: "Create a replacement Environment before deleting this one, or delete the App itself if that is the intent.",
    details: "{ appId: string }",
    related: ["RESOURCE_NOT_EMPTY", "APP_NOT_FOUND"],
  },
  PRIVACY_CONFIRMATION_REQUIRED: {
    remediation: "Resend with the confirmation before details.confirmationExpiresAt",
    cause:
      "A destructive privacy job was submitted without confirmation. These erase subject data irreversibly across every store.",
    fix: "Resend with the confirmation before `details.confirmationExpiresAt`. The window is deliberately short so a stale confirmation cannot authorize a later, different deletion.",
    details: "{ confirmationRequired: true, confirmationExpiresAt: string }",
    related: ["PRIVACY_JOB_FAILED", "PRIVACY_JOB_NOT_FOUND"],
  },
  APPROVAL_REVIEW_FORBIDDEN: {
    remediation:
      "Route the Review to a different approver; details.reason names why this one cannot perform it",
    cause: "This principal may not perform this Review.",
    fix: "`details.reason` distinguishes the two cases. `SELF_REVIEW_NOT_ALLOWED` means the proposer cannot approve their own request, so route it to someone else. `ROLE_NOT_ALLOWED` means this principal's role does not review at all.",
    details:
      '{ approvalRequestId: string, action: "approve_and_apply" | "decline", reason: "SELF_REVIEW_NOT_ALLOWED" | "ROLE_NOT_ALLOWED" }',
    related: ["APPROVAL_REVIEW_REQUIRED", "FORBIDDEN"],
  },
} satisfies Record<string, ErrorDoc>;
