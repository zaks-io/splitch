import type { ErrorDoc } from "./types";

function notFound(resource: string, hint: string): ErrorDoc {
  return {
    cause: `No ${resource} matched the identifier in the request, within the scope your credential can reach.`,
    fix: hint,
  };
}

/**
 * A not-found is scope-relative: an id that exists in another tenant is
 * indistinguishable from one that exists nowhere, because confirming it would
 * leak the other tenant's inventory.
 */
export const lookupErrorDocs = {
  SLUG_CONFLICT: {
    cause:
      "The Organization slug is already taken. Slugs are a global handle, so the winner may be an Organization you cannot see.",
    fix: "Resend the create with a different slug. `details.conflictingSlug` echoes only the slug you sent: no id, name, or owner of the holding Organization is disclosed.",
    details:
      '{ resourceType: "organization", conflictingSlug: string, recommendedAction: "CHOOSE_DIFFERENT_SLUG" }',
    recommendedAction: "CHOOSE_DIFFERENT_SLUG",
    related: ["ORGANIZATION_NOT_FOUND", "VALIDATION_ERROR"],
  },
  MEMBERSHIP_CONFLICT: {
    cause: "The User is already a member of the Organization.",
    fix: "Use the membership update operation when the existing role should change.",
    details: '{ existingRole: "owner" | "admin" | "member" }',
    related: ["USER_NOT_FOUND", "ORGANIZATION_NOT_FOUND"],
  },
  EXPERIMENT_KEY_CONFLICT: {
    cause:
      "An Experiment already holds this `(App, Environment, key)`. Archiving an Experiment does not free its key, so the holder may be archived rather than live.",
    fix: "Resend the create with a different key. `details.status` says whether the holder is `draft`, `running`, `ended`, or `archived`, and an archived holder also carries `details.archivedExperimentId`.",
    details:
      '{ key: string, status: "draft" | "running" | "ended" | "archived", archivedExperimentId?: string, recommendedAction: "CHOOSE_DIFFERENT_KEY" }',
    recommendedAction: "CHOOSE_DIFFERENT_KEY",
    related: ["EXPERIMENT_NOT_FOUND", "SLUG_CONFLICT"],
  },
  SENTRY_INSTALLATION_CONFLICT: {
    cause:
      "The Environment already publishes its Flag changes to a Sentry organization. Sentry's change-tracking payload carries no environment, so a second installation would interleave two Environments' toggles into one audit log.",
    fix: "Revoke the active installation named in `details.activeInstallationId`, then install the new one. Sending the same `installationId` again is a replay and returns the existing installation instead.",
    details: '{ activeInstallationId: string, recommendedAction: "REVOKE_ACTIVE_INSTALLATION" }',
    recommendedAction: "REVOKE_ACTIVE_INSTALLATION",
    related: ["SENTRY_INSTALLATION_NOT_FOUND", "IDEMPOTENCY_KEY_CONFLICT"],
  },

  EXPERIMENT_NOT_FOUND: notFound(
    "Experiment",
    "Confirm the Experiment id and that you are addressing the Environment it lives in. Experiment keys are unique per Environment, so the same key in another Environment is a different Experiment.",
  ),
  RUN_NOT_FOUND: notFound(
    "Run",
    "Confirm the Run id and its Experiment. Runs are addressed under the Experiment that owns them.",
  ),
  FLAG_NOT_FOUND: notFound(
    "Flag",
    "Confirm the Flag id or key and the App. A Flag defined on the App but not yet promoted into this Environment resolves here, so check promotion before assuming the Flag is missing.",
  ),
  VARIANT_NOT_FOUND: notFound(
    "Variant",
    "Confirm the Variant name against the Flag's catalog. A Variant that exists but is not promoted into this Environment reports VARIANT_NOT_AVAILABLE instead.",
  ),
  METRIC_NOT_FOUND: notFound("Metric", "Confirm the Metric id and the App it belongs to."),
  APP_NOT_FOUND: notFound(
    "App",
    "Confirm the App id or slug and that your credential holds membership in the owning Organization.",
  ),
  ORGANIZATION_NOT_FOUND: notFound(
    "Organization",
    "Confirm the Organization id or slug. If you just created it under a provisional token, confirm the demo Organization has not expired.",
  ),
  USER_NOT_FOUND: notFound("user", "Confirm the user id within this Organization's membership."),
  CREDENTIAL_NOT_FOUND: notFound(
    "credential",
    "Confirm the key id. An API Key's secret is shown once at creation and is not recoverable; mint a new key rather than looking the old one up.",
  ),
  CONVEX_INSTALLATION_NOT_FOUND: notFound(
    "Convex installation",
    "Confirm the installation id and that the API Key addresses the App and Environment that own it. Reinstall the component if the installation was revoked.",
  ),
  CLOUDFLARE_INSTALLATION_NOT_FOUND: notFound(
    "Cloudflare installation",
    "Confirm the installation id and that the API Key addresses the App and Environment that own it. Run `splitch cloudflare setup` again if the installation was removed.",
  ),
  SENTRY_INSTALLATION_NOT_FOUND: notFound(
    "Sentry installation",
    "Confirm the installation id and that the operator token addresses the App and Environment that own it. Install the Sentry integration again if it was revoked.",
  ),
  SEGMENT_NOT_FOUND: notFound(
    "Segment",
    "Confirm the Segment id and the Environment it was defined in.",
  ),
  PRIVACY_JOB_NOT_FOUND: notFound(
    "privacy job",
    "Confirm the job id. Completed jobs remain addressable for their retention window and are unreachable after it.",
  ),
  APPROVAL_REQUEST_NOT_FOUND: notFound(
    "Approval Request",
    "Confirm the request id. Requests are scoped to the Environment whose Policy created them.",
  ),
} satisfies Record<string, ErrorDoc>;
