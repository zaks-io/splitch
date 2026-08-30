import { describe, expect, it } from "vitest";
import {
  draftOrganizationIssues,
  organizationIssueFor,
  suggestOrganizationSlug,
} from "#lib/organizations/create-organization-model";

describe("Create Organization draft", () => {
  it("accepts a well-formed draft", () => {
    expect(draftOrganizationIssues({ name: "Vector Supply", slug: "vector-supply" })).toEqual([]);
  });

  it("names a missing Organization name and handle separately", () => {
    const issues = draftOrganizationIssues({ name: "  ", slug: "" });

    expect(organizationIssueFor(issues, "name")).toContain("name");
    expect(organizationIssueFor(issues, "slug")).toContain("URL handle");
  });

  it("refuses a handle the Worker would refuse, before the round trip", () => {
    expect(
      organizationIssueFor(
        draftOrganizationIssues({ name: "Bad Handle", slug: "Bad Handle" }),
        "slug",
      ),
    ).toContain("lowercase");
  });

  it("refuses a reserved handle and says it is reserved", () => {
    expect(
      organizationIssueFor(draftOrganizationIssues({ name: "Billing", slug: "billing" }), "slug"),
    ).toContain("reserved");
  });

  it("refuses a handle shorter than the shared minimum", () => {
    expect(
      organizationIssueFor(draftOrganizationIssues({ name: "Q", slug: "q" }), "slug"),
    ).toContain("at least");
  });

  it("refuses a handle longer than the shared maximum", () => {
    const tooLong = "z".repeat(64);
    expect(
      organizationIssueFor(draftOrganizationIssues({ name: "Long", slug: tooLong }), "slug"),
    ).toContain("at most");
  });

  it("suggests a handle from the name without ever rewriting one the user typed", () => {
    expect(suggestOrganizationSlug("Halyard Freight Co.")).toBe("halyard-freight-co");
    // The suggestion is a starting point only: a typed handle is submitted as
    // typed, and an unusable one is refused rather than silently corrected.
    expect(draftOrganizationIssues({ name: "Halyard", slug: "Halyard Freight Co." })).toHaveLength(
      1,
    );
  });

  it("suggests nothing rather than inventing a handle it cannot derive", () => {
    expect(suggestOrganizationSlug("🌱🌱")).toBe("");
  });
});
