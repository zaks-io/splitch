import type { Repository } from "@splitch/db";
import { describe, expect, it } from "vitest";
import type { AuthKitClient } from "./authkit";
import { completeAuthKitCallback } from "./authkit";

const NOW = Date.UTC(2026, 6, 5, 12, 0, 0);

describe("WorkOS AuthKit callback materialization", () => {
  it("stores the WorkOS JWT only in the KV-backed server session, never in the cookie", async () => {
    const kv = new MemoryKv();
    const expiresAt = Math.floor(NOW / 1000) + 300;
    const accessToken = jwt({ sid: "workos_session_1", exp: expiresAt });
    let authRequest: Parameters<AuthKitClient["authenticateWithCode"]>[0] | undefined;
    const authKit: AuthKitClient = {
      authenticateWithCode: async (request) => {
        authRequest = request;
        return {
          accessToken,
          user: { id: "user_1", email: "user_1@example.com", emailVerified: true },
        };
      },
      getAuthorizationUrl: () => "https://workos.example/authorize",
      getLogoutUrl: () => "https://workos.example/logout",
    };

    const callback = await completeAuthKitCallback({
      authKit,
      clientId: "client_123",
      code: "workos_code",
      kv: kv.namespace(),
      now: NOW,
      repo: repository(),
      request: new Request("https://app.splitch.dev/auth/callback", {
        headers: {
          "cf-connecting-ip": "203.0.113.10",
          "user-agent": "vitest",
        },
      }),
    });

    expect(authRequest).toMatchObject({
      clientId: "client_123",
      code: "workos_code",
      ipAddress: "203.0.113.10",
      userAgent: "vitest",
    });
    expect(callback.cookie).toContain("HttpOnly");
    expect(callback.cookie).toContain("Secure");
    expect(callback.cookie).not.toContain(accessToken);

    const stored = [...kv.store.entries()];
    const joined = stored.map(([, value]) => value).join("\n");
    expect(joined).toContain("workos_session_1");
    expect(joined).toContain("user_1");
    expect(joined).toContain("checkout-api");
    expect(joined).toContain(accessToken);
    expect(joined).toContain(`"expiresAt":${expiresAt}`);
    expect(joined).toContain("isProvisional");
    expect(callback.cookie).toContain("Max-Age=300");
    const profile = kv.store.get("member-profile:user_1");
    expect(profile).toBe(JSON.stringify({ email: "user_1@example.com" }));
  });

  it("refuses to materialize a session when the WorkOS email is not verified", async () => {
    const authKit: AuthKitClient = {
      authenticateWithCode: async () => ({
        accessToken: jwt({ sid: "workos_session_1", exp: Math.floor(NOW / 1000) + 300 }),
        user: { id: "user_1", email: "user_1@example.com", emailVerified: false },
      }),
      getAuthorizationUrl: () => "https://workos.example/authorize",
      getLogoutUrl: () => "https://workos.example/logout",
    };

    await expect(
      completeAuthKitCallback({
        authKit,
        clientId: "client_123",
        code: "workos_code",
        kv: new MemoryKv().namespace(),
        now: NOW,
        repo: repository(),
        request: new Request("https://app.splitch.dev/auth/callback"),
      }),
    ).rejects.toThrow(/verified email/);
  });

  it("rejects a WorkOS access token without a bounded JWT expiry", async () => {
    const authKit: AuthKitClient = {
      authenticateWithCode: async () => ({
        accessToken: jwt({ sid: "workos_session_1" }),
        user: { id: "user_1", email: "user_1@example.com", emailVerified: true },
      }),
      getAuthorizationUrl: () => "https://workos.example/authorize",
      getLogoutUrl: () => "https://workos.example/logout",
    };

    await expect(
      completeAuthKitCallback({
        authKit,
        clientId: "client_123",
        code: "workos_code",
        kv: new MemoryKv().namespace(),
        now: NOW,
        repo: repository(),
        request: new Request("https://app.splitch.dev/auth/callback"),
      }),
    ).rejects.toThrow("incomplete access token claims");
  });
});

function repository(): Repository {
  return {
    identity: {
      listOrgMembershipsWithOrgForUser: async () => [
        {
          role: "admin",
          org: {
            createdAt: "2026-07-05T12:00:00.000Z",
            demoExpiresAt: null,
            id: "org_1",
            isProvisional: false,
            name: "Acme",
            slug: "acme",
            plan: "free",
            updatedAt: "2026-07-05T12:00:00.000Z",
          },
        },
      ],
      listAppMembershipsWithAppForUser: async () => [
        {
          role: "viewer",
          app: {
            createdAt: "2026-07-05T12:00:00.000Z",
            description: null,
            id: "app_1",
            key: "checkout-api",
            name: "Checkout API",
            organizationId: "org_1",
            updatedAt: "2026-07-05T12:00:00.000Z",
          },
        },
      ],
    },
  } as unknown as Repository;
}

function jwt(payload: Record<string, unknown>): string {
  return `header.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`;
}

class MemoryKv {
  readonly store = new Map<string, string>();

  namespace(): KVNamespace {
    return this as unknown as KVNamespace;
  }

  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }

  async put(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
}
