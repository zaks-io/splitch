import { env } from "cloudflare:workers";
import { MEMBERSHIP_WIDE_READ_AUTHORIZATION } from "@splitch/contracts";
import { createRepository } from "@splitch/db";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app";
import { seedOrgApp, seedOrgMember } from "../src/test-seeds";

/**
 * `privacy_requests_get` is the one unavailable-slice route a membership-wide
 * read token can reach (the rest are writes, refused earlier by the read-only
 * gate), and its addressability check is the second consumer of the registrar's
 * `organizationAccessCovers` / `appAccessCovers` predicates. Nothing exercised
 * that check before: disabling both gates outright left the whole
 * control-plane-api suite green, because `requireOrgRole` re-reads D1 and
 * refuses independently. These pin the short-circuit itself by asserting the
 * refusal REASON, which is what tells the two layers apart.
 */

const OWNED = {
  orgId: "org_privacy_owned_31c8",
  orgName: "Owned Org",
  appId: "app_privacy_owned_31c8",
  appName: "Owned",
  appKey: "owned-prod",
};
const FOREIGN = {
  orgId: "org_privacy_foreign_9b42",
  orgName: "Foreign Org",
  appId: "app_privacy_foreign_9b42",
  appName: "Foreign",
  appKey: "foreign-prod",
};

const WIDE_USER = "user_privacy_wide_5a17";
const OTHER_USER = "user_privacy_other_7e93";
const NOW = "2026-06-29T12:00:00.000Z";

beforeAll(async () => {
  await seedOrgApp(env.DB, OWNED);
  await seedOrgApp(env.DB, FOREIGN);
  await seedOrgMember(env.DB, { orgId: OWNED.orgId, userId: WIDE_USER, role: "owner" });
  await seedPrivacyRequest({ requestId: "prq_owned", orgId: OWNED.orgId, appId: null });
  await seedPrivacyRequest({
    requestId: "prq_foreign_org",
    orgId: FOREIGN.orgId,
    appId: null,
  });
  await seedPrivacyRequest({
    requestId: "prq_foreign_app",
    orgId: FOREIGN.orgId,
    appId: FOREIGN.appId,
  });
});

describe("membership-wide privacy-request scope", () => {
  it("refuses an Organization the wide token does not hold, at the scope check", async () => {
    const response = await request("/privacy/requests/prq_foreign_org");

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      code: "FORBIDDEN",
      message: "credential is not scoped to this organization",
    });
  });

  it("refuses an App the wide token does not hold, at the scope check", async () => {
    const response = await request("/privacy/requests/prq_foreign_app");

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      code: "FORBIDDEN",
      message: "credential is not scoped to this organization or app",
    });
  });

  // The predicate this route now shares also throws on a wide principal whose
  // live memberships were never populated, where the optional chain it replaced
  // read that broken invariant as an ordinary "not scoped" refusal (ADR-0036).
  it("fails loud when a wide principal has no live memberships", async () => {
    const onError = vi.fn();
    const response = await request("/privacy/requests/prq_owned", {
      memberships: undefined,
      onError,
    });

    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({
        cause: expect.objectContaining({
          message: "worker-runtime: membership-wide principal has no live memberships",
        }),
      }),
    );
  });

  // Both cases above are refusals, so a gate that rejected every wide token would
  // satisfy them. This one pins the other direction: an Organization the token
  // does hold as owner clears the scope check and the D1 role re-read, and stops
  // only on the slice's own unavailable response.
  it("lets a wide owner through to the unavailable response", async () => {
    const response = await request("/privacy/requests/prq_owned");

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "SERVICE_UNAVAILABLE" });
  });
});

function request(
  path: string,
  overrides: {
    memberships?: undefined;
    onError?: (event: unknown) => void;
  } = {},
): Promise<Response> {
  const app = createApp({
    authResolver: () => ({
      ok: true,
      principal: {
        kind: "control-plane-token" as const,
        id: WIDE_USER,
        scopes: [],
        orgId: null,
        appId: null,
        environmentId: null,
        authDoor: "device_flow" as const,
        authorization: MEMBERSHIP_WIDE_READ_AUTHORIZATION,
        memberships:
          "memberships" in overrides
            ? overrides.memberships
            : {
                organizations: [{ id: OWNED.orgId, role: "owner" as const }],
                apps: [{ id: OWNED.appId, organizationId: OWNED.orgId, role: "admin" as const }],
              },
      },
    }),
    rateLimiter: () => ({ limited: false }),
    repo: createRepository(env.DB),
    ...(overrides.onError ? { observability: { onError: overrides.onError } } : {}),
  });
  return app.request(path);
}

async function seedPrivacyRequest(row: {
  requestId: string;
  orgId: string;
  appId: string | null;
}): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO privacy_requests (request_id, org_id, app_id, request_type, subject_type, subject_ref, requested_by, status, received_at, ack_due_at, response_due_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
  )
    .bind(
      row.requestId,
      row.orgId,
      row.appId,
      "export",
      "targeting_key",
      "subject_9f21",
      OTHER_USER,
      "received",
      NOW,
      NOW,
      NOW,
    )
    .run();
}
