import { type CURRENT_KV_SCHEMA_VERSION, eventDefinitionConfigKey } from "@splitch/contracts";
import { appScope, createRepository, type Repository } from "@splitch/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  appToken,
  createDefaultApp,
  type FlagDefinitionHarness,
  makeAppForRepo,
  makeFlagDefinitionHarness,
  NOW_ISO,
  request,
} from "../src/flag-definition-test-harness";
import { seedOrgApp } from "../src/test-seeds";
import { makePoolBindingsWithConfig } from "./pool-bindings";

const DEFINITION_ID = "event_definition_publication";
const EVENT_NAME = "checkout_completed";
const APP_B = "app_event_publication_b";
const DEFINITION_B = "event_definition_publication_b";
const WEB_DEFINITION_ID = "event_definition_web_publication";
const WEB_EVENT_NAME = "page_viewed";

let h: FlagDefinitionHarness;
let appId: string;
let jwt: string;
let repo: Repository;
let store: KVNamespace;

beforeEach(async () => {
  const bindings = await makePoolBindingsWithConfig();
  h = await makeFlagDefinitionHarness(async () => bindings);
  const created = await createDefaultApp(h);
  appId = created.app.id;
  jwt = await appToken(h, appId);
  repo = createRepository(bindings.d1);
  store = bindings.configKv;
  await seedDefinition(repo, appId, DEFINITION_ID, EVENT_NAME);
  h.app = makeAppForRepo(h, repo, undefined, bindings.credentialKv, undefined, store);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await h.bindings.dispose();
});

describe("Event Definition publication", () => {
  it("rejects a missing Entity type without publishing", async () => {
    const response = await publish({ ...validVersion(), entityType: null });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      code: "VALIDATION_ERROR",
      details: { issues: [{ path: ["body", "entityType"] }] },
    });
    await expectUnpublished();
  });

  it("publishes an anonymous-only Web Event Definition Version", async () => {
    await seedDefinition(repo, appId, WEB_DEFINITION_ID, WEB_EVENT_NAME, "web");

    const response = await request(
      h,
      "POST",
      `/apps/${appId}/event-definitions/${WEB_DEFINITION_ID}/versions`,
      jwt,
      { entityType: null, fields: [], dimensions: [] },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ version: 1, entityType: null });
    const config = await store.get(eventDefinitionConfigKey(appId, WEB_EVENT_NAME));
    expect(config).not.toBeNull();
  });

  it("leaves D1 unpublished when the edge write fails, then retries Version 1", async () => {
    const configFailure = new Error("config unavailable");
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    h.app = makeAppForRepo(
      h,
      repo,
      undefined,
      h.bindings.credentialKv,
      undefined,
      failingStore(store, configFailure),
    );

    const failed = await publish(validVersion());
    expect(failed.status).toBe(500);
    expect(error).toHaveBeenCalledWith("EventDefinitionConfigWriteError", {
      appId,
      eventDefinitionId: DEFINITION_ID,
      cause: configFailure,
    });
    await expectUnpublished();

    h.app = makeAppForRepo(h, repo, undefined, h.bindings.credentialKv, undefined, store);
    const retried = await publish(validVersion());
    expect(retried.status).toBe(200);
    expect(await retried.json()).toMatchObject({ version: 1, entityType: "user" });
  });

  it("writes the edge first when D1 fails, then a retry converges", async () => {
    const stateFailure = new Error("D1 unavailable");
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    h.app = makeAppForRepo(
      h,
      failingPublishRepo(repo, stateFailure),
      undefined,
      h.bindings.credentialKv,
      undefined,
      store,
    );

    const failed = await publish(validVersion());
    expect(failed.status).toBe(500);
    expect(error).toHaveBeenCalledWith("EventDefinitionStateWriteError", {
      appId,
      eventDefinitionId: DEFINITION_ID,
      cause: stateFailure,
    });
    const ahead = await readHotConfig();
    expect(ahead.data.version).toMatchObject({ version: 1, entityType: "user" });
    expect(ahead.data.eventDefinition.currentPublishedVersionId).toBe(ahead.data.version.id);
    await expectUnpublished();

    h.app = makeAppForRepo(h, repo, undefined, h.bindings.credentialKv, undefined, store);
    const retried = await publish(validVersion());
    expect(retried.status).toBe(200);
    const version = (await retried.json()) as { id: string; version: number };
    expect(version.version).toBe(1);
    expect((await readDefinition()).current_published_version_id).toBe(version.id);
    expect((await readHotConfig()).data.version.id).toBe(version.id);
  });

  it("refuses a foreign definition at the repository seam when handler lookup is bypassed", async () => {
    await seedOrgApp(h.bindings.d1, {
      orgId: "org_event_publication_b",
      orgName: "Event Publication B",
      appId: APP_B,
      appName: "Event Publication B",
      appKey: "event-publication-b",
    });
    await seedDefinition(repo, APP_B, DEFINITION_B, "foreign_checkout_completed");
    const foreign = await repo.eventDefinitions.get(appScope(APP_B), DEFINITION_B);
    if (!foreign) throw new Error("foreign Event Definition seed missing");
    const bypassedLookup = {
      ...repo,
      eventDefinitions: { ...repo.eventDefinitions, get: async () => foreign },
    } as Repository;
    h.app = makeAppForRepo(h, bypassedLookup, undefined, h.bindings.credentialKv, undefined, store);

    const response = await request(
      h,
      "POST",
      `/apps/${appId}/event-definitions/${DEFINITION_B}/versions`,
      jwt,
      validVersion(),
    );
    expect(response.status).toBe(404);
    expect(await rawVersions(DEFINITION_B)).toEqual([]);
    expect(await store.get(eventDefinitionConfigKey(appId, foreign.name))).toBeNull();

    const direct = await repo.eventDefinitions.publish(
      appScope(appId),
      {
        id: "event_definition_version_cross_app",
        appId,
        eventDefinitionId: DEFINITION_B,
        version: 1,
        schemaHash: "cross-app",
        entityType: "user",
        fields: "[]",
        dimensions: "[]",
        publishedAt: NOW_ISO,
      },
      NOW_ISO,
      "test",
    );
    expect(direct).toBeNull();
    expect(await rawVersions(DEFINITION_B)).toEqual([]);
  });
});

function validVersion(): Record<string, unknown> {
  return {
    entityType: "user",
    fields: [{ name: "converted", type: "boolean", required: true }],
    dimensions: [],
  };
}

function publish(body: Record<string, unknown>): Promise<Response> {
  return request(
    h,
    "POST",
    `/apps/${appId}/event-definitions/${DEFINITION_ID}/versions`,
    jwt,
    body,
  );
}

async function seedDefinition(
  targetRepo: Repository,
  targetAppId: string,
  id: string,
  name: string,
  family: "metric" | "web" = "metric",
): Promise<void> {
  await targetRepo.eventDefinitions.definitions.insert(appScope(targetAppId), {
    id,
    appId: targetAppId,
    name,
    family,
    displayName: name,
    currentPublishedVersionId: null,
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
  });
}

function failingStore(target: KVNamespace, failure: Error): KVNamespace {
  return new Proxy(target, {
    get(source, property) {
      if (property === "put") return async () => Promise.reject(failure);
      return Reflect.get(source, property);
    },
  });
}

function failingPublishRepo(target: Repository, failure: Error): Repository {
  return {
    ...target,
    eventDefinitions: {
      ...target.eventDefinitions,
      publish: async () => Promise.reject(failure),
    },
  } as Repository;
}

async function expectUnpublished(): Promise<void> {
  expect((await readDefinition()).current_published_version_id).toBeNull();
  expect(await rawVersions(DEFINITION_ID)).toEqual([]);
}

async function readDefinition() {
  const row = await h.bindings.d1
    .prepare("SELECT current_published_version_id FROM event_definitions WHERE id = ?")
    .bind(DEFINITION_ID)
    .first<{ current_published_version_id: string | null }>();
  if (!row) throw new Error("Event Definition missing");
  return row;
}

async function rawVersions(eventDefinitionId: string): Promise<unknown[]> {
  const rows = await h.bindings.d1
    .prepare(
      "SELECT id, app_id, version FROM event_definition_versions WHERE event_definition_id = ?",
    )
    .bind(eventDefinitionId)
    .all();
  return rows.results;
}

async function readHotConfig() {
  const raw = await store.get(eventDefinitionConfigKey(appId, EVENT_NAME));
  if (!raw) throw new Error("Event Definition config missing");
  return JSON.parse(raw) as {
    schemaVersion: typeof CURRENT_KV_SCHEMA_VERSION;
    data: {
      eventDefinition: { currentPublishedVersionId: string };
      version: { id: string; version: number; entityType: string };
    };
  };
}
