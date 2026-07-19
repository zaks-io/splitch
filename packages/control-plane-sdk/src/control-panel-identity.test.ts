import { describe, expect, it } from "vitest";
import {
  issueControlPanelIdentity,
  parseControlPanelIdentity,
  parseControlPanelOperation,
  serializeControlPanelIdentity,
  verifyControlPanelIdentity,
} from "./control-panel-identity";

const NOW = 1_800_000_000;
const operation = { id: "flags_list", appId: "app_1", environmentId: "env_1" } as const;

describe("Control Panel downstream identity", () => {
  it("round-trips an operation and resource scoped identity", () => {
    const identity = issueControlPanelIdentity(operation, "user_1", {
      nowSeconds: NOW,
      sessionExpiresAt: NOW + 3_600,
      nonce: "nonce_1234567890abcdef",
    });

    expect(parseControlPanelIdentity(serializeControlPanelIdentity(identity))).toEqual(identity);
    expect(verifyControlPanelIdentity(identity, operation, NOW)).toBe(true);
  });

  it("rejects operation, App, Environment, expiry, and excess-lifetime mismatches", () => {
    const identity = issueControlPanelIdentity(operation, "user_1", {
      nowSeconds: NOW,
      sessionExpiresAt: NOW + 30,
      nonce: "nonce_1234567890abcdef",
    });

    expect(verifyControlPanelIdentity(identity, { ...operation, id: "flags_create" }, NOW)).toBe(
      false,
    );
    expect(verifyControlPanelIdentity(identity, { ...operation, appId: "app_2" }, NOW)).toBe(false);
    expect(
      verifyControlPanelIdentity(identity, { ...operation, environmentId: "env_2" }, NOW),
    ).toBe(false);
    expect(verifyControlPanelIdentity(identity, operation, NOW + 30)).toBe(false);
    expect(verifyControlPanelIdentity({ ...identity, expiresAt: NOW + 31 }, operation, NOW)).toBe(
      false,
    );
  });

  it("parses only the binding allowlist", () => {
    expect(parseControlPanelOperation("POST", "/orgs/org_1/apps")).toEqual({
      id: "apps_create",
      orgId: "org_1",
    });
    expect(parseControlPanelOperation("GET", "/apps/app_1/flags", "env_1")).toEqual(operation);
    expect(parseControlPanelOperation("PATCH", "/apps/app_1/flags", "env_1")).toBeNull();
  });

  it("rejects malformed and over-posted identities", () => {
    const overPosted = encodeURIComponent(
      JSON.stringify({
        version: 1,
        operation,
        actorId: "user_1",
        expiresAt: NOW + 30,
        nonce: "nonce_1234567890abcdef",
        sessionHash: "must-not-cross",
      }),
    );
    expect(parseControlPanelIdentity(overPosted)).toBeNull();
    expect(parseControlPanelIdentity("not-json")).toBeNull();
  });
});
