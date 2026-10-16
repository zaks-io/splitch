import { describe, expect, it } from "vitest";
import {
  type PersonalAccessTokenStepUpInput,
  personalAccessTokenNeedsStepUp,
  personalAccessTokenStepUpReason,
} from "./personal-access-token-step-up";
import {
  type PersonalAccessTokenGrant,
  personalAccessTokenPermissions,
} from "./personal-access-tokens";

const EXPIRES_AT = "2026-12-01T00:00:00.000Z";
const SHORTER_EXPIRY = "2026-11-01T00:00:00.000Z";
const appGrant: PersonalAccessTokenGrant = {
  target: "app:app_payments",
  role: "admin",
  permissions: ["write"],
};
const orgGrant: PersonalAccessTokenGrant = { ...appGrant, target: "org:org_payments" };
const broadGrant: PersonalAccessTokenGrant = {
  target: "all",
  role: "owner",
  permissions: [...personalAccessTokenPermissions],
};
const readOnlyBroadGrant: PersonalAccessTokenGrant = { ...broadGrant, permissions: [] };
const base: PersonalAccessTokenStepUpInput = {
  operation: "create",
  scopes: ["app:app_payments:admin"],
  grants: [appGrant],
  expiresAt: EXPIRES_AT,
  apps: [
    { id: "app_payments", organizationId: "org_payments" },
    { id: "app_reports", organizationId: "org_payments" },
    { id: "app_other", organizationId: "org_other" },
  ],
};

function needs(input: Partial<PersonalAccessTokenStepUpInput> = {}) {
  return personalAccessTokenNeedsStepUp({ ...base, ...input });
}

describe("personalAccessTokenNeedsStepUp", () => {
  it("allows finite issuance at or below a matching App or Organization scope", () => {
    expect(needs()).toBe(false);
    expect(needs({ grants: [{ ...appGrant, role: "member", permissions: [] }] })).toBe(false);
    expect(needs({ scopes: ["org:org_payments:owner"], grants: [orgGrant] })).toBe(false);
    expect(needs({ expiresAt: undefined })).toBe(false);
  });

  it("lets an Organization scope cover only its known Apps", () => {
    expect(needs({ scopes: ["org:org_payments:admin"] })).toBe(false);
    expect(needs({ scopes: ["org:org_other:owner"] })).toBe(true);
    expect(needs({ scopes: ["org:org_payments:owner"], apps: [] })).toBe(true);
    expect(needs({ grants: [orgGrant] })).toBe(true);
    expect(needs({ grants: [{ ...appGrant, target: "app:app_reports" }] })).toBe(true);
  });

  it.each([
    ["all memberships", { grants: [broadGrant] }],
    ["an out-of-scope App", { grants: [{ ...appGrant, target: "app:app_other" }] }],
    ["an out-of-scope Organization", { grants: [{ ...orgGrant, target: "org:org_other" }] }],
    ["a higher role ceiling", { grants: [{ ...appGrant, role: "owner" as const }] }],
    ["permanent expiry", { expiresAt: null }],
    ["no scopes", { scopes: [] }],
    ["a malformed scope", { scopes: ["app:app_payments:owner:extra"] }],
  ] as const)("requires approval for %s", (_name, input) => {
    expect(needs(input)).toBe(true);
  });

  it("requires every resulting grant to be covered by an applicable scope", () => {
    const other: PersonalAccessTokenGrant = { ...appGrant, target: "app:app_other" };
    expect(needs({ grants: [appGrant, other] })).toBe(true);
    expect(
      needs({
        grants: [appGrant, other],
        scopes: [...base.scopes, "org:org_other:admin"],
      }),
    ).toBe(false);
    expect(needs({ scopes: ["app:app_other:owner", "app:app_payments:member"] })).toBe(true);
  });

  it.each(personalAccessTokenPermissions)(
    "requires approval for %s permission over read-only session authority",
    (permission) => {
      expect(
        needs({
          authorization: "membership-wide-read",
          grants: [{ ...appGrant, permissions: [permission] }],
        }),
      ).toBe(true);
      expect(needs({ grants: [{ ...appGrant, permissions: [permission] }] })).toBe(false);
    },
  );

  it("allows read-only grants only where the read-only session has target and role authority", () => {
    expect(
      needs({
        authorization: "membership-wide-read",
        grants: [{ ...appGrant, permissions: [] }],
      }),
    ).toBe(false);
    expect(
      needs({
        authorization: "membership-wide-read",
        grants: [{ ...appGrant, role: "owner", permissions: [] }],
      }),
    ).toBe(true);
  });
});

describe("personalAccessTokenNeedsStepUp updates", () => {
  it.each(personalAccessTokenPermissions)(
    "requires approval when an update adds %s even within the caller's scope",
    (permission) => {
      expect(
        needs({
          operation: "update",
          current: { grants: [{ ...appGrant, permissions: [] }], expiresAt: EXPIRES_AT },
          grants: [{ ...appGrant, permissions: [permission] }],
        }),
      ).toBe(true);
    },
  );

  it.each([
    ["adds a target", [appGrant, { ...appGrant, target: "app:app_reports" }]],
    ["widens App to Organization", [orgGrant]],
    ["raises the role ceiling", [{ ...appGrant, role: "owner" as const }]],
  ] as const)(
    "requires approval when an update %s despite wider caller authority",
    (_name, grants) => {
      expect(
        needs({
          operation: "update",
          scopes: ["org:org_payments:owner"],
          current: { grants: [appGrant], expiresAt: EXPIRES_AT },
          grants,
        }),
      ).toBe(true);
    },
  );

  it("requires approval when a finite token becomes permanent", () => {
    expect(
      needs({
        operation: "update",
        current: { grants: [appGrant], expiresAt: EXPIRES_AT },
        expiresAt: null,
      }),
    ).toBe(true);
  });

  it.each([
    ["removes permissions", [readOnlyBroadGrant]],
    ["lowers the role", [{ ...broadGrant, role: "member" as const }]],
    ["narrows the target", [orgGrant]],
  ] as const)("allows cleanup that %s on an already permanent broad token", (_name, grants) => {
    expect(
      needs({
        operation: "update",
        scopes: [],
        current: { grants: [broadGrant], expiresAt: null },
        grants,
        expiresAt: undefined,
      }),
    ).toBe(false);
  });

  it("allows dropping a grant and narrowing an Organization grant to one of its Apps", () => {
    expect(
      needs({
        operation: "update",
        scopes: [],
        current: { grants: [appGrant, orgGrant], expiresAt: EXPIRES_AT },
        grants: [appGrant],
      }),
    ).toBe(false);
    expect(
      needs({
        operation: "update",
        scopes: [],
        current: { grants: [orgGrant], expiresAt: EXPIRES_AT },
      }),
    ).toBe(false);
  });

  it.each([EXPIRES_AT, null])("allows shortening %s expiry outside caller authority", (expiry) => {
    expect(
      needs({
        operation: "update",
        scopes: [],
        current: { grants: [broadGrant], expiresAt: expiry },
        grants: undefined,
        expiresAt: SHORTER_EXPIRY,
      }),
    ).toBe(false);
  });

  it("does not treat widening combined with shorter expiry as cleanup", () => {
    expect(
      needs({
        operation: "update",
        current: { grants: [{ ...appGrant, permissions: [] }], expiresAt: EXPIRES_AT },
        expiresAt: SHORTER_EXPIRY,
      }),
    ).toBe(true);
  });

  it("does not treat a permanent no-op or narrowing with an expiry extension as cleanup", () => {
    expect(
      needs({
        operation: "update",
        current: { grants: [broadGrant], expiresAt: null },
        grants: undefined,
        expiresAt: undefined,
      }),
    ).toBe(true);
    expect(
      needs({
        operation: "update",
        scopes: [],
        current: { grants: [broadGrant], expiresAt: SHORTER_EXPIRY },
        grants: [orgGrant],
      }),
    ).toBe(true);
  });
});

describe("personalAccessTokenNeedsStepUp rotation and cleanup", () => {
  it.each([
    ["within-scope finite", [appGrant], EXPIRES_AT, false],
    ["all-memberships", [broadGrant], EXPIRES_AT, true],
    ["out-of-scope", [orgGrant], EXPIRES_AT, true],
    ["permanent", [appGrant], null, true],
  ] as const)(
    "checks stored %s authority before rotation",
    (_name, grants, expiresAt, expected) => {
      expect(
        needs({
          operation: "rotate",
          current: { grants, expiresAt },
          grants: undefined,
          expiresAt: undefined,
        }),
      ).toBe(expected);
    },
  );

  it.each(["list", "revoke", "revoke-all"] as const)("never gates %s cleanup", (operation) => {
    expect(personalAccessTokenNeedsStepUp({ operation, scopes: [] })).toBe(false);
  });

  it("fails loudly when mutation authority is missing", () => {
    expect(() => needs({ operation: "update" })).toThrow("stored token");
    expect(() => needs({ operation: "rotate" })).toThrow("stored token");
    expect(() => needs({ grants: [] })).toThrow("resulting grants");
    expect(() => needs({ grants: undefined })).toThrow("resulting grants");
  });

  it("returns a reason without echoing an out-of-scope target", () => {
    const reason = personalAccessTokenStepUpReason({
      ...base,
      grants: [{ ...appGrant, target: "app:app_private_membership" }],
    });
    expect(reason).toContain("exceeds this session");
    expect(reason).not.toContain("app_private_membership");
    expect(personalAccessTokenStepUpReason(base)).toBeNull();
  });
});
