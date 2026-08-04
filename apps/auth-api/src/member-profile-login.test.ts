import { MemberProfileCacheSchema, memberProfileCacheKey } from "@splitch/contracts";
import { describe, expect, it } from "vitest";
import type { DeviceFlowPort } from "./device-flow";
import type { DeviceRefreshSession } from "./device-session-store";
import { form, routeApp, selectedDeviceCode, unusedRefreshStore } from "./oauth-route-test-harness";
import { memoryKvNamespace } from "./test-kv";

/**
 * SPL-293: device-flow login must write member-profile:{userId} so a subsequent
 * Org-members list can resolve the owner's email. Refresh is the backfill path
 * for sessions minted before the cache existed.
 */
describe("device login writes the shared member-profile identity cache", () => {
  it("stores the verified email on device-code exchange and returns it on the token", async () => {
    const values = new Map<string, string>();
    const sessionStore = memoryKvNamespace(values);
    const remembered: DeviceRefreshSession[] = [];
    const app = routeApp({
      deviceFlow: deviceFlowWithEmail("owner@splitch.test"),
      deviceRefreshSessions: {
        ...unusedRefreshStore,
        remember: async (_token, session) => {
          remembered.push(session);
        },
      },
      sessionStore,
    });

    const res = await app.request("/oauth2/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        client_id: "splitch-cli",
        device_code: await selectedDeviceCode("approved", null),
      }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      user_id: "user_device",
      email: "owner@splitch.test",
    });
    expect(remembered).toHaveLength(1);
    const cached = values.get(memberProfileCacheKey("user_device"));
    expect(cached).toBeDefined();
    expect(MemberProfileCacheSchema.parse(JSON.parse(cached as string))).toEqual({
      email: "owner@splitch.test",
    });
  });

  it("backfills member-profile on refresh for an existing session", async () => {
    const values = new Map<string, string>();
    const sessionStore = memoryKvNamespace(values);
    const app = routeApp({
      deviceFlow: {
        authorizeDevice: async () => {
          throw new Error("not used");
        },
        exchangeDeviceCode: async () => {
          throw new Error("not used");
        },
        refreshProviderToken: async () => ({
          userId: "user_device",
          email: "backfill@splitch.test",
          refreshToken: "refresh_rotated",
          providerSessionId: "session_selected",
        }),
        revokeProviderToken: async () => {
          throw new Error("not used");
        },
      },
      deviceRefreshSessions: {
        remember: async () => {},
        lookup: async () => ({
          providerSessionId: "session_selected",
          userId: "user_device",
          providerOrganizationId: null,
          selectedAppSelector: null,
        }),
        rotate: async () => {},
        forget: async () => {},
      },
      sessionStore,
    });

    expect(values.has(memberProfileCacheKey("user_device"))).toBe(false);

    const res = await app.request("/oauth2/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form({
        grant_type: "refresh_token",
        client_id: "splitch-cli",
        refresh_token: "refresh_original",
      }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      user_id: "user_device",
      email: "backfill@splitch.test",
    });
    expect(
      MemberProfileCacheSchema.parse(
        JSON.parse(values.get(memberProfileCacheKey("user_device")) as string),
      ),
    ).toEqual({ email: "backfill@splitch.test" });
  });

  it("fails loud with email_unverified when the provider user has no verified email", async () => {
    const app = routeApp({
      deviceFlow: deviceFlowWithEmail(undefined),
      deviceRefreshSessions: unusedRefreshStore,
    });

    const res = await app.request("/oauth2/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        client_id: "splitch-cli",
        device_code: await selectedDeviceCode("approved", null),
      }),
    });

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({
      error: "email_unverified",
      error_description: expect.stringContaining("verified email"),
    });
  });
});

describe("refresh rotates before email_unverified so verify-then-retry stays live", () => {
  it("persists the rotated provider token, then succeeds with that same token after verification", async () => {
    const values = new Map<string, string>();
    const sessionStore = memoryKvNamespace(values);
    const sessions = new Map<string, DeviceRefreshSession>();
    sessions.set("refresh_original", {
      providerSessionId: "session_selected",
      userId: "user_device",
      providerOrganizationId: null,
      selectedAppSelector: null,
    });

    let emailVerified = false;
    const rotations: Array<{ previous: string; next: string }> = [];
    const app = routeApp({
      deviceFlow: {
        authorizeDevice: async () => {
          throw new Error("not used");
        },
        exchangeDeviceCode: async () => {
          throw new Error("not used");
        },
        refreshProviderToken: async ({ refreshToken }) => {
          if (!sessions.has(refreshToken)) {
            throw new Error(`provider rejected unknown refresh token ${refreshToken}`);
          }
          return {
            userId: "user_device",
            ...(emailVerified ? { email: "verified@splitch.test" } : {}),
            refreshToken: "refresh_rotated",
            providerSessionId: "session_selected",
          };
        },
        revokeProviderToken: async () => {
          throw new Error("not used");
        },
      },
      deviceRefreshSessions: {
        remember: async (token, session) => {
          sessions.set(token, session);
        },
        lookup: async (token) => sessions.get(token) ?? null,
        rotate: async (previous, next, session) => {
          rotations.push({ previous, next });
          sessions.set(next, session);
          sessions.delete(previous);
        },
        forget: async (token) => {
          sessions.delete(token);
        },
      },
      sessionStore,
    });

    const first = await app.request("/oauth2/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form({
        grant_type: "refresh_token",
        client_id: "splitch-cli",
        refresh_token: "refresh_original",
      }),
    });
    expect(first.status).toBe(403);
    const firstBody = (await first.json()) as {
      error: string;
      refresh_token?: string;
    };
    expect(firstBody).toMatchObject({
      error: "email_unverified",
      refresh_token: "refresh_rotated",
    });
    expect(rotations).toEqual([{ previous: "refresh_original", next: "refresh_rotated" }]);
    expect(sessions.has("refresh_original")).toBe(false);
    expect(sessions.has("refresh_rotated")).toBe(true);

    emailVerified = true;
    const second = await app.request("/oauth2/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form({
        grant_type: "refresh_token",
        client_id: "splitch-cli",
        refresh_token: firstBody.refresh_token as string,
      }),
    });
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({
      user_id: "user_device",
      email: "verified@splitch.test",
      refresh_token: "refresh_rotated",
    });
    expect(
      MemberProfileCacheSchema.parse(
        JSON.parse(values.get(memberProfileCacheKey("user_device")) as string),
      ),
    ).toEqual({ email: "verified@splitch.test" });
  });
});

function deviceFlowWithEmail(email: string | undefined): DeviceFlowPort {
  return {
    authorizeDevice: async () => {
      throw new Error("not used");
    },
    exchangeDeviceCode: async () => ({
      userId: "user_device",
      ...(email ? { email } : {}),
      refreshToken: "refresh_selected",
      providerSessionId: "session_selected",
    }),
    refreshProviderToken: async () => {
      throw new Error("not used");
    },
    revokeProviderToken: async () => {
      throw new Error("not used");
    },
  };
}
