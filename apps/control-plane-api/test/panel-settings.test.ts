import { env } from "cloudflare:workers";
import type { ControlPanelOperation } from "@splitch/control-plane-sdk/control-panel-identity";
import type { PanelEnvironmentSettings } from "@splitch/control-plane-sdk/panel-settings";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { SignedControlPanelEntrypoint } from "../src/index.js";
import { sha256Hex } from "../src/credential-cache.js";
import {
  panelEntrypoint,
  panelFlagsIds,
  panelTestEnv,
  seedAppMembership,
  seedPanelFlags,
  signedPanelRequest,
} from "./panel-flags-harness.js";

const ids = panelFlagsIds("settings");
const { appId: APP_ID, envId: ENVIRONMENT_ID, userId: USER_ID } = ids;
let entrypoint: SignedControlPanelEntrypoint;

beforeAll(async () => {
  await seedPanelFlags(ids);
  entrypoint = panelEntrypoint(panelTestEnv());
});

afterAll(() => vi.unstubAllGlobals());

describe("SignedControlPanelEntrypoint Environment settings", () => {
  it("returns a public Client Key and metadata-only API Key records", async () => {
    const initial = await panelRequest(
      "GET",
      `/control-panel/apps/${APP_ID}/envs/${ENVIRONMENT_ID}/settings`,
    );
    expect(initial.status).toBe(200);
    expect(await initial.json()).toMatchObject({
      environment: {
        id: ENVIRONMENT_ID,
        policy: {
          variantAvailability: "allow",
          targetingRolloutValue: "allow",
          enabledState: "allow",
          startExperimentRun: "allow",
        },
      },
      clientKey: {
        appId: APP_ID,
        environmentId: ENVIRONMENT_ID,
        isOriginOpen: true,
      },
      apiKeys: [],
    });

    const created = await panelRequest("POST", apiKeysPath(), {
      scopes: ["data-plane:evaluate", "data-plane:write"],
    });
    expect(created.status).toBe(200);
    const onceOnly = (await created.json()) as {
      credential: { keyId: string };
      value: string;
    };
    expect(onceOnly.value).toMatch(/^sk_/u);

    const listed = await panelRequest(
      "GET",
      `/control-panel/apps/${APP_ID}/envs/${ENVIRONMENT_ID}/settings`,
    );
    const listedText = await listed.text();
    const keyHash = await sha256Hex(onceOnly.value);
    expect(listedText).not.toContain(onceOnly.value);
    expect(listedText).not.toContain(keyHash);
    expect(JSON.parse(listedText)).toMatchObject({
      apiKeys: [
        {
          keyId: onceOnly.credential.keyId,
          keyHashPrefix: keyHash.slice(0, 12),
          scopes: ["data-plane:evaluate", "data-plane:write"],
          revokedAt: null,
        },
      ],
    });
  });

  it("round-trips origin locking, Policy edits, and fail-loud revocation", async () => {
    const locked = await panelRequest(
      "PATCH",
      `/apps/${APP_ID}/envs/${ENVIRONMENT_ID}/client-key`,
      { originAllowlist: ["https://app.example.com"] },
    );
    expect(locked.status).toBe(200);
    expect(await locked.json()).toMatchObject({
      isOriginOpen: false,
      originAllowlist: ["https://app.example.com"],
    });

    const policy = {
      variantAvailability: "confirm",
      targetingRolloutValue: "confirm",
      enabledState: "confirm",
      startExperimentRun: "confirm",
    } as const;
    const updated = await panelRequest("PATCH", `/apps/${APP_ID}/envs/${ENVIRONMENT_ID}`, {
      policy,
    });
    expect(updated.status).toBe(200);
    expect(await updated.json()).toMatchObject({ policy });

    const created = await panelRequest("POST", apiKeysPath(), {
      scopes: ["data-plane:evaluate", "data-plane:write"],
    });
    const activeKey = ((await created.json()) as { credential: { keyId: string } }).credential;

    const revoked = await panelRequest("POST", `${apiKeysPath()}/${activeKey.keyId}/revoke`, {});
    expect(revoked.status).toBe(200);
    expect(await revoked.json()).toMatchObject({
      keyId: activeKey.keyId,
      revokedAt: expect.any(String),
    });

    const truth = await panelRequest(
      "GET",
      `/control-panel/apps/${APP_ID}/envs/${ENVIRONMENT_ID}/settings`,
    );
    const truthBody = (await truth.json()) as PanelEnvironmentSettings;
    expect(truthBody).toMatchObject({
      environment: { policy },
      clientKey: {
        isOriginOpen: false,
        originAllowlist: ["https://app.example.com"],
      },
    });
    expect(truthBody.apiKeys).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ keyId: activeKey.keyId, revokedAt: expect.any(String) }),
      ]),
    );
  });

  it("rechecks live membership and binds revoke to the exact API Key", async () => {
    await env.DB.prepare("DELETE FROM app_memberships WHERE app_id = ? AND user_id = ?")
      .bind(APP_ID, USER_ID)
      .run();
    const forbidden = await panelRequest(
      "GET",
      `/control-panel/apps/${APP_ID}/envs/${ENVIRONMENT_ID}/settings`,
    );
    expect(forbidden.status).toBe(401);
    await seedAppMembership(ids);

    const path = `${apiKeysPath()}/ak_missing/revoke`;
    const wrongKey: ControlPanelOperation = {
      id: "api_key_revoke",
      appId: APP_ID,
      environmentId: ENVIRONMENT_ID,
      keyId: "ak_other",
    };
    const bound = await entrypoint.fetch(await signedPanelRequest(ids, "POST", path, {}, wrongKey));
    expect(bound.status).toBe(401);
  });
});

function apiKeysPath(): string {
  return `/apps/${APP_ID}/envs/${ENVIRONMENT_ID}/api-keys`;
}

async function panelRequest(method: string, path: string, body?: unknown): Promise<Response> {
  return entrypoint.fetch(await signedPanelRequest(ids, method, path, body));
}
