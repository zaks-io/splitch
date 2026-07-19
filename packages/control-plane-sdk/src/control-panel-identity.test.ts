import { describe, expect, it } from "vitest";
import {
  issueControlPanelDelegation,
  parseControlPanelOperation,
  verifyControlPanelDelegation,
} from "./control-panel-identity";

const NOW = 1_800_000_000;
const SECRET = "test-control-panel-delegation-secret-1234";
const operation = { id: "flags_create", appId: "app_1", environmentId: "env_1" } as const;

describe("Control Panel delegation", () => {
  it("authenticates actor, operation, resources, expiry, nonce, and canonical body", async () => {
    const request = jsonRequest({ key: "checkout", appId: "app_1" });
    const delegation = await issueControlPanelDelegation(request, operation, "user_1", SECRET, {
      nowSeconds: NOW,
      sessionExpiresAt: NOW + 3_600,
      nonce: "nonce_1234567890abcdef",
    });

    await expect(
      verifyControlPanelDelegation(delegation, request, operation, SECRET, NOW),
    ).resolves.toMatchObject({
      operation,
      actorId: "user_1",
      expiresAt: NOW + 30,
      nonce: "nonce_1234567890abcdef",
      bodyDigest: expect.stringMatching(/^sha256:/u),
    });
    await expect(
      verifyControlPanelDelegation(
        delegation,
        jsonRequest({ appId: "app_1", key: "checkout" }),
        operation,
        SECRET,
        NOW,
      ),
    ).resolves.not.toBeNull();
  });

  it("rejects a different request body and a forged signature", async () => {
    const request = jsonRequest({ appId: "app_1", key: "checkout" });
    const delegation = await issueControlPanelDelegation(request, operation, "user_1", SECRET, {
      nowSeconds: NOW,
      sessionExpiresAt: NOW + 30,
      nonce: "nonce_1234567890abcdef",
    });

    await expect(
      verifyControlPanelDelegation(
        delegation,
        jsonRequest({ appId: "app_1", key: "other" }),
        operation,
        SECRET,
        NOW,
      ),
    ).resolves.toBeNull();
    await expect(
      verifyControlPanelDelegation(`${delegation.slice(0, -1)}x`, request, operation, SECRET, NOW),
    ).resolves.toBeNull();
    await expect(
      verifyControlPanelDelegation(delegation, request, operation, `${SECRET}wrong`, NOW),
    ).resolves.toBeNull();
  });

  it("rejects operation, App, Environment, and expiry mismatches", async () => {
    const request = jsonRequest({ appId: "app_1", key: "checkout" });
    const delegation = await issueControlPanelDelegation(request, operation, "user_1", SECRET, {
      nowSeconds: NOW,
      sessionExpiresAt: NOW + 30,
      nonce: "nonce_1234567890abcdef",
    });

    await expect(
      verifyControlPanelDelegation(
        delegation,
        request,
        { ...operation, id: "flags_list" },
        SECRET,
        NOW,
      ),
    ).resolves.toBeNull();
    await expect(
      verifyControlPanelDelegation(
        delegation,
        request,
        { ...operation, appId: "app_2" },
        SECRET,
        NOW,
      ),
    ).resolves.toBeNull();
    await expect(
      verifyControlPanelDelegation(
        delegation,
        request,
        { ...operation, environmentId: "env_2" },
        SECRET,
        NOW,
      ),
    ).resolves.toBeNull();
    await expect(
      verifyControlPanelDelegation(delegation, request, operation, SECRET, NOW + 30),
    ).resolves.toBeNull();
  });

  it("parses only the binding allowlist", () => {
    expect(parseControlPanelOperation("POST", "/orgs/org_1/apps")).toEqual({
      id: "apps_create",
      orgId: "org_1",
    });
    expect(parseControlPanelOperation("GET", "/apps/app_1/flags", "env_1")).toEqual({
      id: "flags_list",
      appId: "app_1",
      environmentId: "env_1",
    });
    expect(parseControlPanelOperation("PATCH", "/apps/app_1/flags", "env_1")).toBeNull();
  });
});

function jsonRequest(body: unknown): Request {
  return new Request("https://control-plane.internal/apps/app_1/flags", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
