import type { StoredSession } from "#lib/sessions/session";

export const NOW = Date.UTC(2026, 6, 5, 12, 0, 0);

export function sessionPrincipal(): Omit<StoredSession, "expiresAt"> {
  return {
    userId: "user_1",
    workosSessionId: "workos_session_1",
    orgs: [
      {
        orgId: "org_1",
        orgRole: "admin",
        orgSlug: "acme",
        isProvisional: false,
        demoExpiresAt: null,
        apps: [
          {
            appId: "app_1",
            appSlug: "checkout-api",
            role: "viewer",
          },
        ],
      },
    ],
  };
}

export class MemoryKv {
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
