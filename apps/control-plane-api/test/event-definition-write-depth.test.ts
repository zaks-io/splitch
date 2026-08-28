import { appScope, createRepository, type Repository } from "@splitch/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appToken,
  createDefaultApp,
  type FlagDefinitionHarness,
  makeAppForRepo,
  makeFlagDefinitionHarness,
  NOW_ISO,
  request,
} from "../src/flag-definition-test-harness";
import { makePoolBindingsWithConfig } from "./pool-bindings";

const DEFINITION_ID = "event_definition_write_depth";
const EVENT_NAME = "depth_guarded_payload";

let h: FlagDefinitionHarness;
let appId: string;
let jwt: string;

beforeEach(async () => {
  const bindings = await makePoolBindingsWithConfig();
  h = await makeFlagDefinitionHarness(async () => bindings);
  const created = await createDefaultApp(h);
  appId = created.app.id;
  jwt = await appToken(h, appId);
  const repo = createRepository(bindings.d1);
  await seedDefinition(repo, appId);
  h.app = makeAppForRepo(h, repo, undefined, bindings.credentialKv, undefined, bindings.configKv);
});

afterEach(async () => h.bindings.dispose());

describe("Event Definition publication depth guard", () => {
  it("rejects a depth-2000 Closed JSON document without publishing", async () => {
    let jsonSchema: Record<string, unknown> = { type: "null" };
    for (let depth = 0; depth < 2000; depth += 1) {
      jsonSchema = { type: "array", items: jsonSchema };
    }
    const response = await request(
      h,
      "POST",
      `/apps/${appId}/event-definitions/${DEFINITION_ID}/versions`,
      jwt,
      {
        entityType: "user",
        fields: [{ name: "payload", type: "json", required: false, jsonSchema }],
        dimensions: [],
      },
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      code: "VALIDATION_ERROR",
      details: { issues: [{ path: expect.arrayContaining(["body", "fields"]) }] },
    });
    const published = await h.bindings.d1
      .prepare("SELECT current_published_version_id FROM event_definitions WHERE id = ?")
      .bind(DEFINITION_ID)
      .first<{ current_published_version_id: string | null }>();
    expect(published?.current_published_version_id).toBeNull();
  });

  it("rejects a type:null + properties chain at depth 2000 with 400 before auth", async () => {
    let jsonSchema: Record<string, unknown> = { type: "null" };
    for (let depth = 0; depth < 2000; depth += 1) {
      jsonSchema = { type: "null", properties: { child: jsonSchema } };
    }
    const response = await h.app.request(
      `/apps/${appId}/event-definitions/${DEFINITION_ID}/versions`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          entityType: "user",
          fields: [{ name: "payload", type: "json", required: false, jsonSchema }],
          dimensions: [],
        }),
      },
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      code: "VALIDATION_ERROR",
      details: { issues: [{ path: expect.arrayContaining(["body", "fields"]) }] },
    });
  });
});

async function seedDefinition(repo: Repository, targetAppId: string): Promise<void> {
  await repo.eventDefinitions.definitions.insert(appScope(targetAppId), {
    id: DEFINITION_ID,
    appId: targetAppId,
    name: EVENT_NAME,
    family: "metric",
    displayName: EVENT_NAME,
    currentPublishedVersionId: null,
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
  });
}
