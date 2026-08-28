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

const DEFINITION_ID = "event_definition_write_unknown_keys";
const EVENT_NAME = "unknown_key_payload";

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

describe("Event Definition publication unknown-key paths", () => {
  it("reports the exact unknown field key and does not publish", async () => {
    const response = await request(
      h,
      "POST",
      `/apps/${appId}/event-definitions/${DEFINITION_ID}/versions`,
      jwt,
      {
        entityType: "user",
        fields: [{ name: "x", type: "boolean", required: false, extra: true }],
        dimensions: [],
      },
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      code: "VALIDATION_ERROR",
      details: {
        issues: [{ path: ["body", "fields", "0", "extra"], message: 'Unrecognized key: "extra"' }],
      },
    });
    const published = await h.bindings.d1
      .prepare("SELECT current_published_version_id FROM event_definitions WHERE id = ?")
      .bind(DEFINITION_ID)
      .first<{ current_published_version_id: string | null }>();
    expect(published?.current_published_version_id).toBeNull();
  });

  it("reports only extra on a legitimate Closed JSON object", async () => {
    const response = await request(
      h,
      "POST",
      `/apps/${appId}/event-definitions/${DEFINITION_ID}/versions`,
      jwt,
      {
        entityType: "user",
        fields: [
          {
            name: "payload",
            type: "json",
            required: false,
            jsonSchema: {
              type: "object",
              properties: { foo: { type: "null" } },
              additionalProperties: false,
              extra: true,
            },
          },
        ],
        dimensions: [],
      },
    );
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body).toMatchObject({
      code: "VALIDATION_ERROR",
      details: {
        issues: [
          {
            path: ["body", "fields", "0", "jsonSchema", "extra"],
            message: 'Unrecognized key: "extra"',
          },
        ],
      },
    });
    expect(JSON.stringify(body)).not.toContain("properties");
    expect(JSON.stringify(body)).not.toContain("additionalProperties");
  });

  it("reports the invalid discriminator instead of an unrelated Closed JSON key", async () => {
    const response = await request(
      h,
      "POST",
      `/apps/${appId}/event-definitions/${DEFINITION_ID}/versions`,
      jwt,
      {
        entityType: "user",
        fields: [
          {
            name: "payload",
            type: "json",
            required: false,
            jsonSchema: { type: "c", a: "value" },
          },
        ],
        dimensions: [],
      },
    );
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body).toMatchObject({
      code: "VALIDATION_ERROR",
      details: {
        issues: [{ path: ["body", "fields", "0", "jsonSchema", "type"] }],
      },
    });
    expect(JSON.stringify(body)).not.toContain('"a"');
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
