import { cliClientErrorCodes } from "@splitch/cli";
import { errorCodes } from "@splitch/contracts";
import { resolveErrorDocsUrl, sdkClientErrorCodes } from "@splitch/sdk";
import { describe, expect, it } from "vitest";
import { errorMarkdown } from "../markdown";
import { DOCS_ORIGIN, docsPath } from "../site";
import {
  documentedErrorCodes,
  errorDocs,
  httpStatusForDocumentedCode,
  isDocumentedErrorCode,
  surfaceForCode,
  wireErrorDocs,
} from "./index";

const allCodes = [...errorCodes, ...sdkClientErrorCodes, ...cliClientErrorCodes];

// Fits an 80-column terminal wrapped to two lines beside a prefix, and leaves a
// CLI room to append its own clause.
const REMEDIATION_MAX_CHARS = 120;

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

  it("carries a remediation on every wire code and none on the client families", () => {
    // The wire catalog is the single definition the docs page, the terminal, and
    // an MCP result all read. The client families are deliberately absent: their
    // remediation is written where the error is raised, which can name the file
    // or host involved.
    for (const code of errorCodes) {
      expect(wireErrorDocs[code].remediation.length, code).toBeGreaterThan(0);
    }
    for (const code of [...sdkClientErrorCodes, ...cliClientErrorCodes]) {
      expect(errorDocs[code].remediation, code).toBeUndefined();
    }
  });

  it("keeps every remediation printable on one terminal line", () => {
    for (const code of errorCodes) {
      const line = wireErrorDocs[code].remediation;
      expect(line.length, code).toBeLessThanOrEqual(REMEDIATION_MAX_CHARS);
      // Backticks and newlines render as literal junk in a terminal, and a second
      // sentence means the copy grew into the long-form `fix` that lives below it.
      expect(line, code).not.toMatch(/[\n`]/);
      expect(line, code).not.toMatch(/\. /);
      expect(line.endsWith("."), code).toBe(false);
    }
  });

  it("writes every remediation as an instruction, not a description", () => {
    for (const code of errorCodes) {
      const line = wireErrorDocs[code].remediation;
      expect(line[0], code).toBe(line[0]?.toUpperCase());
      // An opening article or pronoun is the tell that the sentence describes the
      // failure instead of naming the next action.
      expect(line, code).not.toMatch(/^(The|This|That|A|An|It|You|Your|There) /);
    }
  });

  it("keeps surface-specific copy out of the shared remediation", () => {
    // The CLI appends `--confirm` and MCP appends the inline `review` argument at
    // print time. A surface token baked in here would be wrong on the other two.
    for (const code of errorCodes) {
      expect(wireErrorDocs[code].remediation, code).not.toMatch(/--|splitch |review[=:]/);
    }
  });

  it("leads the agent-facing markdown with the remediation", () => {
    // An agent reads `/docs/error/{code}.md` mid-failure. The action it should
    // take has to appear before the explanation of what went wrong.
    for (const code of errorCodes) {
      const md = errorMarkdown(code);
      expect(md, code).toContain(`## Remediation\n\n${wireErrorDocs[code].remediation}`);
      expect(md.indexOf("## Remediation"), code).toBeLessThan(md.indexOf("## Cause"));
    }
    for (const code of cliClientErrorCodes) {
      expect(errorMarkdown(code), code).not.toContain("## Remediation");
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
