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
} satisfies Record<string, ErrorDoc>;
