import { describe, expect, it } from "vitest";
import { appIssueFor, draftAppIssues, suggestAppKey } from "./create-app-model";

describe("Create App draft", () => {
  it("accepts a well-formed draft", () => {
    expect(draftAppIssues({ name: "Checkout API", key: "checkout-api" })).toEqual([]);
  });

  it("requires a name and a slug", () => {
    const issues = draftAppIssues({ name: "  ", key: "" });

    expect(appIssueFor(issues, "name")).toBe("Give the App a name.");
    expect(appIssueFor(issues, "key")).toBe("Give the App a URL slug.");
  });

  it("rejects slugs the URL and the CLI cannot carry", () => {
    for (const key of ["Checkout API", "checkout_api", "-checkout", "checkout-", "check--out"]) {
      expect(appIssueFor(draftAppIssues({ name: "Checkout", key }), "key")).toBe(
        "Use lowercase letters, digits, and single hyphens, e.g. checkout-api.",
      );
    }
  });

  it("suggests the slug from the name", () => {
    expect(suggestAppKey("Checkout API")).toBe("checkout-api");
    expect(suggestAppKey("  Billing (v2)!  ")).toBe("billing-v2");
  });
});
