import { type ErrorCode, errorCodes, httpStatusForError } from "@splitch/contracts";
import { approvalErrorDocs } from "./api-approval";
import { authErrorDocs } from "./api-auth";
import { decisionErrorDocs } from "./api-decision";
import { eventErrorDocs } from "./api-events";
import { lookupErrorDocs } from "./api-lookup";
import { runErrorDocs } from "./api-run";
import { systemErrorDocs } from "./api-system";
import { validationErrorDocs } from "./api-validation";
import { cliErrorDocs } from "./cli-client";
import { sdkErrorDocs } from "./sdk-client";
import type { DocumentedErrorCode, ErrorDoc, ErrorSurface } from "./types";

export type { DocumentedErrorCode, ErrorDoc, ErrorSurface } from "./types";

/**
 * The `SDK_`/`CLI_` prefixes are the structural difference between the client
 * families and the wire contract. `error-catalog.test.ts` proves this agrees
 * with the shipped code arrays, so the site never has to import the CLI at
 * runtime to classify a page.
 */
export function surfaceForCode(code: DocumentedErrorCode): ErrorSurface {
  if (code.startsWith("SDK_")) return "sdk";
  if (code.startsWith("CLI_")) return "cli";
  return "api";
}

export const surfaceLabels: Record<ErrorSurface, string> = {
  api: "API",
  sdk: "SDK",
  cli: "CLI",
};

/** The order the catalog is presented in, on the page and in Markdown. */
export const errorSurfaces: readonly ErrorSurface[] = ["api", "sdk", "cli"];

export const surfaceBlurbs: Record<ErrorSurface, string> = {
  api: "Returned by the splitch API, with an HTTP status.",
  sdk: "Thrown by @splitch/sdk at construction, before any request goes out.",
  cli: "Raised by splitch itself. Each one carries the process exit code it returns.",
};

/**
 * The wire families alone. `satisfies Record<ErrorCode, ErrorDoc & { remediation: string }>`
 * is the second gate: a new wire code has to arrive with its terminal sentence,
 * and a code that is not on the wire cannot be smuggled in here.
 */
const wireCatalog = {
  ...validationErrorDocs,
  ...eventErrorDocs,
  ...runErrorDocs,
  ...lookupErrorDocs,
  ...authErrorDocs,
  ...approvalErrorDocs,
  ...decisionErrorDocs,
  ...systemErrorDocs,
} satisfies Record<ErrorCode, ErrorDoc & { remediation: string }>;

/**
 * One page per documented code. `satisfies Record<DocumentedErrorCode, ErrorDoc>`
 * is the coverage gate: adding a code to `errorCodes`, `sdkClientErrorCodes`, or
 * `cliClientErrorCodes` without an entry here fails the typecheck rather than
 * shipping a `/docs/error/{code}` link that 404s.
 */
const catalog = {
  ...wireCatalog,
  ...sdkErrorDocs,
  ...cliErrorDocs,
} satisfies Record<DocumentedErrorCode, ErrorDoc>;

// `satisfies` above keeps the exhaustiveness check against the literal; the
// annotation here gives every consumer one uniform shape instead of a 72-member
// union where the optional fields exist on only some branches.
export const errorDocs: Record<DocumentedErrorCode, ErrorDoc> = catalog;

/**
 * The wire slice, typed with `remediation` REQUIRED. A terminal or MCP renderer
 * reads this rather than `errorDocs` so a missing sentence is a typecheck
 * failure at the call site instead of an `undefined` printed as blank advice.
 */
export const wireErrorDocs: Record<ErrorCode, ErrorDoc & { remediation: string }> = wireCatalog;

export const documentedErrorCodes = Object.keys(errorDocs).sort() as DocumentedErrorCode[];

export function isDocumentedErrorCode(value: string): value is DocumentedErrorCode {
  // Own-property, not `in`: `in` reaches Object.prototype, so `/docs/error/toString`
  // would clear the guard and then render a page built from a method.
  return Object.hasOwn(errorDocs, value);
}

/**
 * HTTP status for the wire contract, `null` for the client-only families: an
 * `SDK_*` or `CLI_*` code never travelled over HTTP, and printing a status for
 * one would invent a response that does not exist.
 */
const wireCodes = new Set<string>(errorCodes);

export function httpStatusForDocumentedCode(code: DocumentedErrorCode): number | null {
  return wireCodes.has(code) ? httpStatusForError(code as ErrorCode) : null;
}

/**
 * The one-token fact that ranks a code at a glance: the HTTP status it arrives
 * with, or the process exit code the CLI returns. `null` for the SDK family,
 * which has neither.
 */
export function errorCodeMarker(code: DocumentedErrorCode): string | null {
  const status = httpStatusForDocumentedCode(code);
  if (status !== null) return String(status);
  const exitCode = errorDocs[code].exitCode;
  return exitCode === undefined ? null : `exit ${exitCode}`;
}

export function documentedCodesBySurface(): Record<ErrorSurface, DocumentedErrorCode[]> {
  return {
    api: documentedErrorCodes.filter((code) => surfaceForCode(code) === "api"),
    sdk: documentedErrorCodes.filter((code) => surfaceForCode(code) === "sdk"),
    cli: documentedErrorCodes.filter((code) => surfaceForCode(code) === "cli"),
  };
}
