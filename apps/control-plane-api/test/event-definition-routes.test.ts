import type { ErrorResponse } from "@splitch/contracts";
import { appScope, createRepository } from "@splitch/db";
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
import { seedOrgApp } from "../src/test-seeds";
import { makePoolBindingsWithConfig } from "./pool-bindings";

const APP_B = "app_event_definition_b";
const MISSING_APP = "app_event_definition_missing";
const DEFINITION_A = "event_definition_route_a";
const DEFINITION_B = "event_definition_route_b";
const VERSION_A = "event_definition_version_route_a";
const VERSION_B = "event_definition_version_route_b";
const MISSING_DEFINITION = "event_definition_missing";
const MISSING_VERSION = "event_definition_version_missing";

const routes = [
  "list",
  "create",
  "get",
  "update",
  "publish",
  "listVersions",
  "getVersion",
] as const;
type Route = (typeof routes)[number];

interface Fixture {
  h: FlagDefinitionHarness;
  appA: string;
  jwtA: string;
  eventDefinitionStore: KVNamespace;
}

let f: Fixture;

beforeEach(async () => {
  const bindings = await makePoolBindingsWithConfig();
  const h = await makeFlagDefinitionHarness(async () => bindings);
  h.app = makeAppForRepo(
    h,
    createRepository(bindings.d1),
    undefined,
    bindings.credentialKv,
    undefined,
    bindings.configKv,
  );
  const created = await createDefaultApp(h);
  await seedOrgApp(bindings.d1, {
    orgId: "org_event_definition_b",
    orgName: "Event Definition B",
    appId: APP_B,
    appName: "Event Definition B",
    appKey: "event-definition-b",
  });
  await seedDefinition(h, created.app.id, DEFINITION_A, VERSION_A, "checkout_completed");
  await seedDefinition(h, APP_B, DEFINITION_B, VERSION_B, "foreign_checkout_completed");
  f = {
    h,
    appA: created.app.id,
    jwtA: await appToken(h, created.app.id),
    eventDefinitionStore: bindings.configKv,
  };
});

afterEach(async () => f.h.bindings.dispose());

describe("Event Definition routes", () => {
  it.each(routes)("%s succeeds in its App", async (route) => {
    const response = await invoke(route, f.appA, DEFINITION_A, VERSION_A, f.jwtA, "local_route");
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    assertHappy(route, body);
  });

  it.each(routes)("%s refuses an App A credential addressing App B", async (route) => {
    const before = await foreignState();
    const appId = isCollectionRoute(route) ? APP_B : f.appA;
    const response = await invoke(route, appId, DEFINITION_B, VERSION_B, f.jwtA, "foreign_route");
    const expected = crossAppError(route);
    expect(response.status).toBe(expected.status);
    expect(((await response.json()) as ErrorResponse).code).toBe(expected.code);
    expect(await foreignState()).toEqual(before);
  });

  it.each(routes)("%s reports its missing resource", async (route) => {
    const appMissing = isCollectionRoute(route);
    const jwt = appMissing ? await appToken(f.h, MISSING_APP) : f.jwtA;
    const response = await invoke(
      route,
      appMissing ? MISSING_APP : f.appA,
      route === "getVersion" ? DEFINITION_A : MISSING_DEFINITION,
      MISSING_VERSION,
      jwt,
      "missing_route",
    );
    expect(response.status).toBe(404);
    expect(((await response.json()) as ErrorResponse).code).toBe(missingErrorCode(route));
  });
});

function isCollectionRoute(route: Route): boolean {
  return route === "list" || route === "create";
}

function crossAppError(route: Route): { status: number; code: ErrorResponse["code"] } {
  if (isCollectionRoute(route)) return { status: 403, code: "FORBIDDEN" };
  return { status: 404, code: missingErrorCode(route) };
}

function missingErrorCode(route: Route): ErrorResponse["code"] {
  if (isCollectionRoute(route)) return "APP_NOT_FOUND";
  return route === "getVersion"
    ? "EVENT_DEFINITION_VERSION_NOT_FOUND"
    : "EVENT_DEFINITION_NOT_FOUND";
}

async function invoke(
  route: Route,
  appId: string,
  definitionId: string,
  versionId: string,
  jwt: string,
  name: string,
): Promise<Response> {
  const base = `/apps/${appId}/event-definitions`;
  switch (route) {
    case "list":
      return request(f.h, "GET", base, jwt);
    case "create":
      return request(f.h, "POST", base, jwt, {
        name,
        family: "metric",
        displayName: "Local route",
      });
    case "get":
      return request(f.h, "GET", `${base}/${definitionId}`, jwt);
    case "update":
      return request(f.h, "PATCH", `${base}/${definitionId}`, jwt, {
        displayName: "Updated route",
      });
    case "publish":
      return request(f.h, "POST", `${base}/${definitionId}/versions`, jwt, {
        entityType: "user",
        fields: [{ name: "converted", type: "boolean", required: true }],
        dimensions: [],
      });
    case "listVersions":
      return request(f.h, "GET", `${base}/${definitionId}/versions`, jwt);
    case "getVersion":
      return request(f.h, "GET", `${base}/${definitionId}/versions/${versionId}`, jwt);
  }
}

function assertHappy(route: Route, body: Record<string, unknown>): void {
  if (route === "list" || route === "listVersions") {
    expect(body.items).toEqual(expect.arrayContaining([expect.any(Object)]));
  } else if (route === "create") {
    expect(body).toMatchObject({ appId: f.appA, name: "local_route" });
  } else if (route === "update") {
    expect(body).toMatchObject({ id: DEFINITION_A, displayName: "Updated route" });
  } else if (route === "publish") {
    expect(body).toMatchObject({ eventDefinitionId: DEFINITION_A, version: 2 });
  } else if (route === "get") {
    expect(body).toMatchObject({ id: DEFINITION_A, versions: [{ id: VERSION_A }] });
  } else {
    expect(body).toMatchObject({ id: VERSION_A, eventDefinitionId: DEFINITION_A });
  }
}

async function seedDefinition(
  h: FlagDefinitionHarness,
  appId: string,
  id: string,
  versionId: string,
  name: string,
): Promise<void> {
  const repo = createRepository(h.bindings.d1);
  const scope = appScope(appId);
  await repo.eventDefinitions.definitions.insert(scope, {
    id,
    appId,
    name,
    family: "metric",
    displayName: name,
    currentPublishedVersionId: null,
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
  });
  await repo.eventDefinitions.publish(
    scope,
    {
      id: versionId,
      appId,
      eventDefinitionId: id,
      version: 1,
      schemaHash: `sha256:${"a".repeat(64)}`,
      entityType: "user",
      fields: "[]",
      dimensions: "[]",
      publishedAt: NOW_ISO,
    },
    NOW_ISO,
    "test",
  );
}

async function foreignState(): Promise<unknown> {
  const definition = await f.h.bindings.d1
    .prepare(
      `SELECT display_name, current_published_version_id
       FROM event_definitions WHERE id = ?`,
    )
    .bind(DEFINITION_B)
    .first<{ display_name: string; current_published_version_id: string | null }>();
  const versions = await f.h.bindings.d1
    .prepare(
      `SELECT id, app_id FROM event_definition_versions
       WHERE event_definition_id = ? ORDER BY version`,
    )
    .bind(DEFINITION_B)
    .all<{ id: string; app_id: string }>();
  return {
    displayName: definition?.display_name,
    currentPublishedVersionId: definition?.current_published_version_id,
    versions: versions.results,
  };
}
