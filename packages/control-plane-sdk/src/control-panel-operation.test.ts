import { describe, expect, it } from "vitest";
import { parseControlPanelOperation } from "./control-panel-operation";
import { isControlPanelOperation, sameOperation } from "./control-panel-operation-guards";

/**
 * `organizations_create` is the second unbound operation in the protocol (SPL-205).
 * Unbound means the delegation claim carries the operation id and nothing else,
 * so the guard that decides what a valid claim looks like is the only thing
 * standing between "no resource named" and "any resource named".
 */
describe("organizations_create operation", () => {
  it("parses POST /orgs, with or without the trailing slash", () => {
    expect(parseControlPanelOperation("POST", "/orgs")).toEqual({ id: "organizations_create" });
    expect(parseControlPanelOperation("POST", "/orgs/")).toEqual({ id: "organizations_create" });
  });

  it("does not parse a read of the same collection", () => {
    expect(parseControlPanelOperation("GET", "/orgs")).toBeNull();
  });

  it("stays disjoint from apps_create on the neighbouring path", () => {
    expect(parseControlPanelOperation("POST", "/orgs/org_seed_a/apps")).toEqual({
      id: "apps_create",
      orgId: "org_seed_a",
    });
    expect(parseControlPanelOperation("POST", "/orgs/org_seed_a")).toBeNull();
  });

  it("accepts a claim that names only the operation", () => {
    expect(isControlPanelOperation({ id: "organizations_create" })).toBe(true);
  });

  it("rejects a claim that smuggles a resource alongside the id", () => {
    // The privilege-escalation shape: an unbound claim is cheap to mint, so it
    // must not be a carrier for an Org the actor has no membership in.
    expect(isControlPanelOperation({ id: "organizations_create", orgId: "org_seed_b" })).toBe(
      false,
    );
    expect(isControlPanelOperation({ id: "organizations_create", appId: "app_seed_b" })).toBe(
      false,
    );
  });

  it("does not treat a delegation for another operation as this one", () => {
    expect(
      sameOperation({ id: "organizations_create" }, { id: "apps_create", orgId: "org_seed_c" }),
    ).toBe(false);
    expect(
      sameOperation({ id: "apps_create", orgId: "org_seed_c" }, { id: "organizations_create" }),
    ).toBe(false);
    expect(sameOperation({ id: "organizations_create" }, { id: "experiments_list" })).toBe(false);
  });

  it("matches itself, since there is no resource left to distinguish two of them", () => {
    expect(sameOperation({ id: "organizations_create" }, { id: "organizations_create" })).toBe(
      true,
    );
  });
});
