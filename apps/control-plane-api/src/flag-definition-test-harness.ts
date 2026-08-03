import type { ErrorResponse } from "@splitch/contracts";
import { createRepository, type Repository } from "@splitch/db";
import type { RateLimiter } from "@splitch/worker-runtime";
import type { Hono } from "hono";
import { expect } from "vitest";
import { createApp } from "./app";
import { ALLOW_POLICY } from "./app-environment-model";
import { makeControlPlaneAuthResolver } from "./auth-resolver";
import type { ConfigStoreAccess } from "./config-store-do";
import { type FixtureSigner, makeFixtureSigner } from "./fixture-signer";
import { makeJwksVerifier } from "./jwks-verify";
import { makeSessionStore } from "./session-store";
import type { RunSnapshotDelivery } from "./run-snapshot";
import type { LocalBindings } from "./test-fixtures";
import { resetOrganizationGraph, seedOrgApp, seedOrgMember } from "./test-seeds";

const AUDIENCE = "https://cp.splitch.test";
const NOW_MS = Date.UTC(2026, 6, 2, 12, 0, 0);
export const NOW_ISO = new Date(NOW_MS).toISOString();
const ORG = {
  orgId: "org_flag_definition_crud",
  orgName: "Flag Definition CRUD Co",
  appId: "app_existing_flag_definition",
  appName: "Existing Flag App",
  appKey: "existing-flag-app",
};

const OWNER = "user_flag_definition_owner";
const allowLimiter: RateLimiter = () => ({ limited: false });
const nowSeconds = () => Math.floor(NOW_MS / 1000);

export interface FlagDefinitionHarness {
  app: Hono;
  signer: FixtureSigner;
  bindings: LocalBindings;
}

/**
 * Build the Flag-definition harness over whichever bindings the caller supplies.
 *
 * The factory is a parameter because this harness runs in two runtimes: Node
 * passes the Miniflare-backed `makeLocalBindings`, the Workers pool passes
 * `makePoolBindings`. Taking it as an argument is what keeps this module free of
 * any Miniflare import, which it must be to load inside workerd at all (Miniflare
 * pulls in `node:process` via chalk).
 *
 * The graph is reset first because the pool isolates storage per test FILE, not
 * per test, and every consumer re-creates the same fixed-key App: without the
 * wipe the second test in a file trips `apps_org_key_unique`.
 */
export async function makeFlagDefinitionHarness(
  makeBindings: () => Promise<LocalBindings>,
): Promise<FlagDefinitionHarness> {
  const bindings = await makeBindings();
  await resetOrganizationGraph(bindings.d1);
  await seedOrgApp(bindings.d1, ORG);
  await seedOrgMember(bindings.d1, {
    orgId: ORG.orgId,
    userId: OWNER,
    role: "owner",
  });

  const signer = await makeFixtureSigner();
  return {
    app: makeAppForRepo({ bindings, signer }, createRepository(bindings.d1)),
    signer,
    bindings,
  };
}

export function makeAppForRepo(
  h: Pick<FlagDefinitionHarness, "bindings" | "signer">,
  repo: Repository,
  configStore?: ConfigStoreAccess,
  credentialStore: KVNamespace = h.bindings.credentialKv,
  runSnapshotDelivery?: RunSnapshotDelivery,
): Hono {
  const verifier = makeJwksVerifier({
    fetchJwks: async () => h.signer.jwks,
    controlPlaneAudience: AUDIENCE,
  });
  return createApp({
    authResolver: makeControlPlaneAuthResolver({
      verifier,
      sessions: makeSessionStore(h.bindings.kv),
      now: () => NOW_MS,
    }),
    rateLimiter: allowLimiter,
    repo,
    configStore,
    runSnapshotDelivery,
    credentialStore,
    nowIso: () => NOW_ISO,
  });
}

export function orgToken(h: FlagDefinitionHarness): Promise<string> {
  return orgTokenFor(h, ORG.orgId);
}

export function orgTokenFor(h: FlagDefinitionHarness, orgId: string): Promise<string> {
  return h.signer.sign({
    sub: OWNER,
    iss: "https://auth.splitch.test",
    aud: AUDIENCE,
    iat: nowSeconds(),
    exp: nowSeconds() + 3600,
    scopes: [`org:${orgId}:owner`],
  });
}

export function appToken(h: FlagDefinitionHarness, appId: string): Promise<string> {
  return h.signer.sign({
    sub: OWNER,
    iss: "https://auth.splitch.test",
    aud: AUDIENCE,
    iat: nowSeconds(),
    exp: nowSeconds() + 3600,
    scopes: [`app:${appId}:owner`],
  });
}

export async function request(
  h: FlagDefinitionHarness,
  method: string,
  path: string,
  jwt: string,
  body?: Record<string, unknown>,
  // DELETE carries no body, so a bodyless route that requires an Idempotency
  // Key has to be given one directly.
  headerIdempotencyKey?: string,
): Promise<Response> {
  const idempotencyKey = headerIdempotencyKey ?? body?.idempotency_key;
  return h.app.request(path, {
    method,
    headers: {
      authorization: `Bearer ${jwt}`,
      ...(body ? { "content-type": "application/json" } : {}),
      ...(typeof idempotencyKey === "string" ? { "idempotency-key": idempotencyKey } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

export async function createDefaultApp(h: FlagDefinitionHarness) {
  const res = await request(h, "POST", `/orgs/${ORG.orgId}/apps`, await orgToken(h), {
    organizationId: ORG.orgId,
    name: "Checkout",
    key: "checkout",
  });
  expect(res.status).toBe(200);
  return (await res.json()) as {
    app: { id: string };
    environments: Array<{ id: string; key: string }>;
  };
}

/**
 * Drop every Environment of an App to `allow`. Catalog membership is gated on
 * `variant_availability`, and a freshly created App's prod Environment ships
 * `confirm`, so any test that is not about the Approval gate has to opt out of
 * it explicitly rather than silently depend on the default.
 */
export async function allowAllPolicies(h: FlagDefinitionHarness, appId: string) {
  await h.bindings.d1
    .prepare("UPDATE environments SET policy = ? WHERE app_id = ?")
    .bind(JSON.stringify(ALLOW_POLICY), appId)
    .run();
}

export function baseFlag(appId: string) {
  return {
    appId,
    // `flags_create` is an Idempotency-Key route, so the body carries the key the
    // request will also send as the `Idempotency-Key` header.
    idempotency_key: `idem-create-flag-${crypto.randomUUID()}`,
    key: "checkout-redesign",
    name: "Checkout redesign",
    schema: { type: "boolean" },
    variants: [
      { name: "control", value: false, isDefault: true },
      { name: "treatment", value: true, isDefault: false },
    ],
  };
}

export async function createFlag(
  h: FlagDefinitionHarness,
  appId: string,
  jwt: string,
  body = baseFlag(appId),
) {
  const idempotencyKey =
    (body as { idempotency_key?: string }).idempotency_key ??
    `idem-create-flag-${crypto.randomUUID()}`;
  const res = await request(
    h,
    "POST",
    `/apps/${appId}/flags`,
    jwt,
    { ...body, idempotency_key: idempotencyKey },
    idempotencyKey,
  );
  if (res.status !== 200) {
    throw new Error(`create flag failed ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as {
    id: string;
    key: string;
    name: string;
    defaultVariantId: string;
    variants: Array<{ id: string; name: string; value: unknown }>;
  };
}

export async function errorBody(res: Response): Promise<ErrorResponse> {
  return (await res.json()) as ErrorResponse;
}
