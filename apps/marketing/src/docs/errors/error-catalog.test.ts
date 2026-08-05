import { cliClientErrorCodes } from "@splitch/cli";
import { errorCodes } from "@splitch/contracts";
import { resolveErrorDocsUrl, sdkClientErrorCodes } from "@splitch/sdk";
import { describe, expect, it } from "vitest";
import { DOCS_ORIGIN, docsPath } from "../site";
import {
  documentedErrorCodes,
  errorDocs,
  httpStatusForDocumentedCode,
  isDocumentedErrorCode,
  surfaceForCode,
} from "./index";

const allCodes = [...errorCodes, ...sdkClientErrorCodes, ...cliClientErrorCodes];

describe("error catalog", () => {
  it("documents every shipped code and nothing else", () => {
    // `satisfies Record<DocumentedErrorCode, ErrorDoc>` catches a missing page at
    // compile time; this catches the other direction, a page for a code that was
    // renamed or removed and would now publish a URL nothing ever emits.
    expect(documentedErrorCodes).toEqual([...allCodes].sort());
  });

  it("classifies surface by prefix consistently with the shipped arrays", () => {
    for (const code of errorCodes) expect(surfaceForCode(code)).toBe("api");
    for (const code of sdkClientErrorCodes) expect(surfaceForCode(code)).toBe("sdk");
    for (const code of cliClientErrorCodes) expect(surfaceForCode(code)).toBe("cli");
  });

  it("gives every page a cause and a fix", () => {
    for (const code of documentedErrorCodes) {
      const doc = errorDocs[code];
      expect(doc.cause.length, code).toBeGreaterThan(0);
      expect(doc.fix.length, code).toBeGreaterThan(0);
    }
  });

  it("only cross-links codes that have pages", () => {
    for (const code of documentedErrorCodes) {
      for (const related of errorDocs[code].related ?? []) {
        expect(isDocumentedErrorCode(related), `${code} -> ${related}`).toBe(true);
      }
    }
  });

  it("reports an HTTP status for wire codes and none for client-only codes", () => {
    for (const code of errorCodes) {
      expect(httpStatusForDocumentedCode(code), code).toBeGreaterThanOrEqual(400);
    }
    for (const code of [...sdkClientErrorCodes, ...cliClientErrorCodes]) {
      expect(httpStatusForDocumentedCode(code), code).toBeNull();
    }
  });

  it("rejects inherited object properties as codes", () => {
    // `value in errorDocs` would clear the guard for every Object.prototype
    // member, and `/docs/error/toString` would render a page built from a method.
    for (const name of ["toString", "constructor", "valueOf", "hasOwnProperty"]) {
      expect(isDocumentedErrorCode(name), name).toBe(false);
    }
  });

  it("serves the exact URL the SDK and CLI print in error messages", () => {
    // Both sides build the URL from the code, independently. If either scheme
    // moves, every printed `Docs:` link 404s, so the agreement is a test rather
    // than a comment on each side.
    for (const code of documentedErrorCodes) {
      expect(resolveErrorDocsUrl(code), code).toBe(`${DOCS_ORIGIN}${docsPath.errorCode(code)}`);
    }
  });

  it("carries an exit code on CLI pages only", () => {
    for (const code of cliClientErrorCodes) {
      expect(errorDocs[code].exitCode, code).toBeGreaterThan(0);
    }
    for (const code of [...errorCodes, ...sdkClientErrorCodes]) {
      expect(errorDocs[code].exitCode, code).toBeUndefined();
    }
  });
});
