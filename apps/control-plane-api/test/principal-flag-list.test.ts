import type { FlagListReadResponse, PrincipalFlagListReadResponse } from "@splitch/contracts";
import { LIST_READ_LIMIT } from "@splitch/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FOREIGN_APP,
  makePrincipalFlagHarness,
  PRINCIPAL_APPS,
  type PrincipalFlagHarness,
} from "./principal-flag-list-fixture";

let h: PrincipalFlagHarness;

beforeEach(async () => {
  h = await makePrincipalFlagHarness();
});

afterEach(async () => h.bindings.dispose());

describe("principal-scoped GET /flags", () => {
  it("returns all and only live member Apps across Organizations in one bounded response", async () => {
    const response = await get("/flags");
    expect(response.status, await response.clone().text()).toBe(200);
    const body = (await response.json()) as PrincipalFlagListReadResponse;

    expect(body.readTruncated).toBe(false);
    expect(body.items.map((row) => [row.app.id, row.key])).toEqual(
      PRINCIPAL_APPS.map((row) => [row.appId, row.flagKey]),
    );
    expect(body.items.map((row) => row.org)).toEqual(
      PRINCIPAL_APPS.map((row) => ({ id: row.orgId, slug: row.orgSlug })),
    );
    expect(new Set(body.items.map((row) => row.id)).size).toBe(3);
    expect(new Set(body.items.map((row) => row.key)).size).toBe(3);
    expect(JSON.stringify(body)).not.toContain(FOREIGN_APP.flagId);
    expect(JSON.stringify(body)).not.toContain(FOREIGN_APP.appId);
  });

  it("is field-identical to each per-App list for a member-role principal", async () => {
    const principal = (await (await get("/flags")).json()) as PrincipalFlagListReadResponse;

    for (const principalRow of principal.items) {
      const scopedResponse = await get(`/apps/${principalRow.app.id}/flags`);
      expect(scopedResponse.status, await scopedResponse.clone().text()).toBe(200);
      const scoped = (await scopedResponse.json()) as FlagListReadResponse;
      const { org: _org, app: _app, ...withoutScope } = principalRow;
      expect(withoutScope).toEqual(scoped.items.find((row) => row.id === principalRow.id));
    }
  });

  it("hydrates every App with the same configuration envelope as flags_list", async () => {
    const principalResponse = await get("/flags?include=config");
    expect(principalResponse.status, await principalResponse.clone().text()).toBe(200);
    const principal = (await principalResponse.json()) as PrincipalFlagListReadResponse;

    for (const principalRow of principal.items) {
      expect(principalRow).toHaveProperty("configurations");
      const scopedResponse = await get(`/apps/${principalRow.app.id}/flags?include=config`);
      expect(scopedResponse.status, await scopedResponse.clone().text()).toBe(200);
      const scoped = (await scopedResponse.json()) as FlagListReadResponse;
      const { org: _org, app: _app, ...withoutScope } = principalRow;
      expect(withoutScope).toEqual(scoped.items.find((row) => row.id === principalRow.id));
    }
  });

  it("invokes each cross-App batch read once for three member Apps", async () => {
    const methodNames = [
      "listFlagPageAcrossApps",
      "listAppDescriptors",
      "listVariantsForFlagsAcrossApps",
      "listEnvironmentsAcrossApps",
      "listFlagConfigsAcrossApps",
      "listTargetingRulesAcrossApps",
      "listRunningExperimentsAcrossApps",
    ] as const;
    const spies = methodNames.map((name) => vi.spyOn(h.repo.flags, name));

    const response = await get("/flags?include=config");
    expect(response.status, await response.clone().text()).toBe(200);
    expect(spies.every((spy) => spy.mock.calls.length === 1)).toBe(true);
    expect(spies[0]?.mock.calls[0]?.[0].appIds).toEqual(PRINCIPAL_APPS.map((row) => row.appId));
  });

  it("reports an above-ceiling principal catalog as incomplete", async () => {
    await h.bindings.dispose();
    h = await makePrincipalFlagHarness(LIST_READ_LIMIT);

    const response = await get("/flags");
    expect(response.status, await response.clone().text()).toBe(200);
    const body = (await response.json()) as PrincipalFlagListReadResponse;
    expect(body.readTruncated).toBe(true);
    expect(body.readLimit).toBe(LIST_READ_LIMIT);
    expect(body.items).toHaveLength(LIST_READ_LIMIT);
  });

  it("rejects a narrow App token before any cross-App repository read", async () => {
    const list = vi.spyOn(h.repo.flags, "listFlagPageAcrossApps");
    const token = await h.signer.sign({
      sub: "user_principal_flags_member",
      iss: "https://auth.splitch.test",
      aud: "https://cp.splitch.test",
      iat: Math.floor(Date.UTC(2026, 7, 28, 12) / 1000),
      exp: Math.floor(Date.UTC(2026, 7, 28, 13) / 1000),
      scopes: [`app:${PRINCIPAL_APPS[0].appId}:member`],
      auth_door: "id_jag",
    });

    const response = await h.app.request("/flags", {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(403);
    expect(list).not.toHaveBeenCalled();
  });
});

async function get(path: string): Promise<Response> {
  return h.app.request(path, {
    headers: { authorization: `Bearer ${await h.token()}` },
  });
}
