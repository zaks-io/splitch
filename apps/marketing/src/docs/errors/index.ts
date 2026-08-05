import { type ErrorCode, errorCodes, httpStatusForError } from "@splitch/contracts";
import { approvalErrorDocs } from "./api-approval";
import { authErrorDocs } from "./api-auth";
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

/**
 * One page per documented code. `satisfies Record<DocumentedErrorCode, ErrorDoc>`
 * is the coverage gate: adding a code to `errorCodes`, `sdkClientErrorCodes`, or
 * `cliClientErrorCodes` without an entry here fails the typecheck rather than
 * shipping a `/docs/error/{code}` link that 404s.
 */
const catalog = {
  ...validationErrorDocs,
  ...runErrorDocs,
  ...lookupErrorDocs,
  ...authErrorDocs,
  ...approvalErrorDocs,
  ...systemErrorDocs,
  ...sdkErrorDocs,
  ...cliErrorDocs,
} satisfies Record<DocumentedErrorCode, ErrorDoc>;

// `satisfies` above keeps the exhaustiveness check against the literal; the
// annotation here gives every consumer one uniform shape instead of a 72-member
// union where the optional fields exist on only some branches.
export const errorDocs: Record<DocumentedErrorCode, ErrorDoc> = catalog;

export const documentedErrorCodes = Object.keys(errorDocs).sort() as DocumentedErrorCode[];

export function isDocumentedErrorCode(value: string): value is DocumentedErrorCode {
  return value in errorDocs;
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

export function documentedCodesBySurface(): {
  api: DocumentedErrorCode[];
  sdk: DocumentedErrorCode[];
  cli: DocumentedErrorCode[];
} {
  return {
    api: documentedErrorCodes.filter((code) => surfaceForCode(code) === "api"),
    sdk: documentedErrorCodes.filter((code) => surfaceForCode(code) === "sdk"),
    cli: documentedErrorCodes.filter((code) => surfaceForCode(code) === "cli"),
  };
}
