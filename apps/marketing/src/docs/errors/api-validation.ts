import type { ErrorDoc } from "./types";

export const validationErrorDocs = {
  VALIDATION_ERROR: {
    cause: "The request body, path, or query failed contract validation at the Worker boundary.",
    fix: "Read `details.issues`: each entry names the failing field path and what was wrong with it. Correct those fields and resend.",
    details: "{ issues: Array<{ path: string[], message: string }> }",
    related: ["ALLOCATION_INVALID", "INVALID_PAGINATION", "INVALID_SORT"],
  },
  ALLOCATION_INVALID: {
    cause: "The Variant allocation percentages on a Run do not sum to 100.",
    fix: "Adjust the allocation so the percentages total exactly 100. `details.variantAllocations` echoes what you sent, keyed by Variant name, and `details.got` is the sum the server computed.",
    details: "{ expected: 100, got: number, variantAllocations: Record<string, number> }",
    related: ["VALIDATION_ERROR", "RUN_FROZEN"],
  },
  ACTIVATION_TIMESTAMP_INVALID: {
    cause:
      "An activation timestamp was placed at or before the first Exposure it would filter, which would silently drop the Entities the Run already measured.",
    fix: "Move the activation timestamp after `details.firstExposureTs`. An activation point earlier than the first Exposure cannot be honored without discarding measured data, so the platform refuses it rather than quietly truncating the analysis window.",
    details:
      '{ activationTs: string, firstExposureTs: string, message: "activation must occur after first exposure" }',
    related: ["VALIDATION_ERROR"],
  },
  INVALID_PAGINATION: {
    cause: "The `cursor` or `limit` on a list request could not be used.",
    fix: "`details.field` names which one, and `details.reason` says why. Drop the cursor and start a fresh page, or bring the limit back inside the documented range.",
    details: '{ field: "cursor" | "limit", reason: string }',
    related: ["INVALID_SORT", "VALIDATION_ERROR"],
  },
  INVALID_SORT: {
    cause: "The requested sort field is not sortable on this collection.",
    fix: "Pick a field from `details.allowedFields`. The list is exact: sorting on an unlisted field is refused rather than silently ignored, which would return a differently ordered page than you asked for.",
    details: "{ field: string, allowedFields: string[] }",
    related: ["INVALID_PAGINATION", "VALIDATION_ERROR"],
  },
  EXPOSURE_TICKET_INVALID: {
    cause:
      "An Exposure Ticket could not be verified: the MAC failed, the payload was tampered, or the ticket's App/Environment does not match the calling credential.",
    fix: "Discard the ticket and call `evaluate-all` again for a fresh resolution. Do not invent or rewrite ticket strings — every Exposure field is bound to a server-issued ticket.",
    details: "{ exposureId: string }",
    related: ["EXPOSURE_TICKET_EXPIRED", "EVENT_ID_CONFLICT", "VALIDATION_ERROR"],
  },
  EXPOSURE_TICKET_EXPIRED: {
    cause: "The Exposure Ticket's `issued_at` is older than the 24-hour redemption TTL.",
    fix: "Call `evaluate-all` again. Revalidation replaces stale tickets long before this TTL; an expired ticket means the client held a payload past its redeem window.",
    details: "{ exposureId: string, issuedAt: string }",
    related: ["EXPOSURE_TICKET_INVALID", "VALIDATION_ERROR"],
  },
  UNSUPPORTED_OBJECT_KEY: {
    cause:
      'A JSON own `"__proto__"` key reached a Zod record that would otherwise silently drop it (Precomputed Evaluations Flag Keys, or a shape that must keep every own key).',
    fix: 'Rename the key away from `"__proto__"`. `details.key` names the offending key and `details.path` is the wire path where it appeared. The platform refuses rather than returning a payload with that entry missing.',
    details: "{ key: string, path: string[] }",
    related: ["VALIDATION_ERROR"],
  },
  EVENT_ID_CONFLICT: {
    cause:
      "The same `exposureId` (or other client-owned event id) was reused with a different payload than the one already accepted.",
    fix: "Keep `exposureId` stable across retries of the same logical first read. Mint a new id only for a new first-read; never attach a different Exposure Ticket to an id that already sealed.",
    details: "{ eventId: string }",
    related: ["EXPOSURE_TICKET_INVALID", "IDEMPOTENCY_KEY_CONFLICT"],
  },
} satisfies Record<string, ErrorDoc>;
