import { canonicalHash } from "@splitch/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appToken,
  baseFlag,
  createDefaultApp,
  errorBody,
  type FlagDefinitionHarness,
  makeFlagDefinitionHarness,
  request,
} from "../src/flag-definition-test-harness";
import { makePoolBindings as makeLocalBindings } from "./pool-bindings";

let h: FlagDefinitionHarness;

beforeEach(async () => {
  h = await makeFlagDefinitionHarness(makeLocalBindings);
});

afterEach(async () => h.bindings.dispose());

/**
 * Rewrites a completed create into the state migration 0036 leaves behind for a
 * create that completed before D9: no class on the request hash or the stored
 * response, and the row itself `unclassified`.
 */
async function rewindToPreLifecycle(flagId: string, legacyPayload: Record<string, unknown>) {
  const row = await h.bindings.d1
    .prepare("SELECT create_response FROM flags WHERE id = ?")
    .bind(flagId)
    .first<{ create_response: string }>();
  if (!row) throw new Error("expected the created Flag row");
  const {
    lifecycleClass: _c,
    owner: _o,
    expiresAt: _e,
    ...legacyResponse
  } = JSON.parse(row.create_response) as Record<string, unknown>;
  await h.bindings.d1
    .prepare(
      `UPDATE flags SET lifecycle_class = 'unclassified', create_request_hash = ?,
         create_response = ? WHERE id = ?`,
    )
    .bind(await canonicalHash(legacyPayload), JSON.stringify(legacyResponse), flagId)
    .run();
  return legacyResponse;
}

describe("flags_create replay across the D9 deploy", () => {
  it("replays a create that completed before lifecycle classes existed", async () => {
    const createdApp = await createDefaultApp(h);
    const appId = createdApp.app.id;
    const jwt = await appToken(h, appId);
    const { lifecycleClass: _, ...preD9Body } = {
      ...baseFlag(appId),
      key: "pre-d9-flag",
      idempotency_key: "idem_pre_d9_create",
    };
    const created = await request(h, "POST", `/apps/${appId}/flags`, jwt, {
      ...preD9Body,
      lifecycleClass: "permission",
    });
    expect(created.status).toBe(200);
    const { id } = (await created.json()) as { id: string };
    const { idempotency_key: _key, ...hashedPayload } = preD9Body;
    const original = await rewindToPreLifecycle(id, hashedPayload);

    const retry = await request(h, "POST", `/apps/${appId}/flags`, jwt, preD9Body);

    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual(original);
  });

  it("still refuses a new create with no lifecycle class", async () => {
    const createdApp = await createDefaultApp(h);
    const appId = createdApp.app.id;
    const jwt = await appToken(h, appId);
    const { lifecycleClass: _, ...unclassified } = {
      ...baseFlag(appId),
      idempotency_key: "idem_new_without_class",
    };

    const res = await request(h, "POST", `/apps/${appId}/flags`, jwt, unclassified);

    expect(res.status).toBe(400);
    expect(await errorBody(res)).toMatchObject({
      code: "VALIDATION_ERROR",
      details: { issues: [{ path: ["body", "lifecycleClass"] }] },
    });
  });
});
