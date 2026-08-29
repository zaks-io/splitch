import type { FlagListReadResponse, PrincipalFlagListReadResponse } from "@splitch/contracts";
import { LIST_READ_LIMIT } from "@splitch/contracts";
import { appScope } from "@splitch/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FOREIGN_APP,
  makePrincipalFlagHarness,
  MEMBER_ORG_NONMEMBER_APP,
  NOW,
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
    expect(JSON.stringify(body)).not.toContain(MEMBER_ORG_NONMEMBER_APP.flagId);
    expect(JSON.stringify(body)).not.toContain(MEMBER_ORG_NONMEMBER_APP.appId);
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

describe("principal-scoped GET /flags Environment selectors", () => {
  it("fans one Environment key out to the matching Environment in every readable App", async () => {
    const response = await get("/flags?include=config&envs=prod");
    expect(response.status, await response.clone().text()).toBe(200);
    const body = (await response.json()) as PrincipalFlagListReadResponse;

    expect(body.items).toHaveLength(PRINCIPAL_APPS.length);
    for (const row of body.items) {
      const app = PRINCIPAL_APPS.find((seed) => seed.appId === row.app.id);
      expect(app, `unexpected App ${row.app.id}`).toBeDefined();
      expect(
        (row as { configurations: { environmentId: string }[] }).configurations.map(
          (config) => config.environmentId,
        ),
      ).toEqual([app?.environmentId]);
    }
    expect(JSON.stringify(body)).not.toContain(FOREIGN_APP.environmentId);
    expect(JSON.stringify(body)).not.toContain(MEMBER_ORG_NONMEMBER_APP.environmentId);
  });

  it("hydrates only the owning App when the selector is one canonical Environment ID", async () => {
    const target = PRINCIPAL_APPS[0];
    const response = await get(`/flags?include=config&envs=${target.environmentId}`);
    expect(response.status, await response.clone().text()).toBe(200);
    const body = (await response.json()) as PrincipalFlagListReadResponse;

    const configurationsByApp = new Map(
      body.items.map((row) => [
        row.app.id,
        (row as { configurations: { environmentId: string }[] }).configurations,
      ]),
    );
    expect(configurationsByApp.get(target.appId)?.map((config) => config.environmentId)).toEqual([
      target.environmentId,
    ]);
    for (const other of PRINCIPAL_APPS.filter((row) => row.appId !== target.appId)) {
      expect(configurationsByApp.get(other.appId)).toEqual([]);
    }
  });

  it("refuses a selector that names no readable Environment instead of hydrating nothing", async () => {
    const response = await get("/flags?include=config&envs=prod,staging");
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: "ENVIRONMENT_NOT_FOUND" });
  });

  it("refuses an Environment that exists only outside the membership set", async () => {
    const response = await get(`/flags?include=config&envs=${FOREIGN_APP.environmentId}`);
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: "ENVIRONMENT_NOT_FOUND" });
  });

  it("names a missing Flag Configuration as a fault instead of an undeclared 500", async () => {
    const target = PRINCIPAL_APPS[0];
    await h.repo.identity.environments.insert(appScope(target.appId), {
      id: "env_principal_alpha_checkout_staging",
      appId: target.appId,
      key: "staging",
      name: "Staging",
      createdAt: NOW,
      updatedAt: NOW,
    });

    const response = await get("/flags?include=config&envs=staging");
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      code: "INTERNAL_SERVER_ERROR",
      details: { fault: "FLAG_CONFIGURATION_MISSING" },
    });
  });
});

async function get(path: string): Promise<Response> {
  return h.app.request(path, {
    headers: { authorization: `Bearer ${await h.token()}` },
  });
}
