import { describe, expect, it } from "vitest";
import { documentTitle } from "#lib/shell/document-title";

describe("documentTitle", () => {
  it("composes page and server-resolved scope from specific to general", () => {
    expect(documentTitle("Flags", "checkout-api", "prod")).toBe(
      "Flags · checkout-api · prod · splitch",
    );
  });

  it("refuses missing title data", () => {
    expect(() => documentTitle("Flag", " ", "prod")).toThrow(
      "Document title parts must not be empty",
    );
  });
});
