import { describe, expect, it } from "vitest";
import { ensurePrincipalEmail } from "./auth-email-backfill.js";
import type { CliCredentialFile, CredentialStore } from "./credentials.js";
import type { SplitchCliError } from "./errors.js";

const LIVE_EXPIRY = new Date(Date.now() + 3_600_000).toISOString();

function emailLessCredential(refreshToken = "refresh-r1"): CliCredentialFile {
  return {
    version: 1,
    principal: { userId: "user_test" },
    credential: {
      type: "device_flow",
      refreshToken,
      accessToken: "access-a1",
      accessTokenExpiresAt: LIVE_EXPIRY,
    },
  };
}

function memoryStore(initial: CliCredentialFile): {
  store: CredentialStore;
  get: () => CliCredentialFile | null;
} {
  let file: CliCredentialFile | null = initial;
  return {
    get: () => file,
    store: {
      load: async () => file,
      save: async (next) => {
        file = next;
      },
      clear: async () => {
        file = null;
      },
    },
  };
}

describe("ensurePrincipalEmail concurrent rotation safety", () => {
  it("does not write a pre-refresh snapshot over a concurrently rotated refresh token", async () => {
    const { store, get } = memoryStore(emailLessCredential("refresh-r1"));
    const rotatedExpiry = new Date(Date.now() + 7_200_000).toISOString();

    const result = await ensurePrincipalEmail({
      credentialStore: store,
      fetch: async () => {
        // Process B rotated R1→R2 and saved while our refresh was in flight.
        const current = get();
        if (!current) throw new Error("missing credential");
        await store.save({
          ...current,
          credential: {
            ...current.credential,
            refreshToken: "refresh-r2",
            accessToken: "access-a2",
            accessTokenExpiresAt: rotatedExpiry,
          },
        });
        return Response.json(
          { error: "server_error", error_description: "auth door fault" },
          { status: 500 },
        );
      },
    });

    expect(result.credential.refreshToken).toBe("refresh-r2");
    expect(get()?.credential.refreshToken).toBe("refresh-r2");
    expect(get()?.credential.accessToken).toBe("access-a2");
    expect(get()?.credential.emailBackfillUnavailableUntil).toBeUndefined();
    expect(get()?.credential.emailBackfillUnavailable).toBeUndefined();
  });

  it("marks the reloaded file when the refresh token is still ours", async () => {
    const { store, get } = memoryStore(emailLessCredential("refresh-r1"));

    const result = await ensurePrincipalEmail({
      credentialStore: store,
      fetch: async () =>
        Response.json(
          { error: "server_error", error_description: "auth door fault" },
          { status: 500 },
        ),
    });

    expect(result.credential.refreshToken).toBe("refresh-r1");
    expect(get()?.credential.emailBackfillUnavailableUntil).toBe(LIVE_EXPIRY);
  });

  it("rethrows CLI_EMAIL_UNVERIFIED instead of marking a silent miss", async () => {
    const { store, get } = memoryStore(emailLessCredential("refresh-r1"));

    await expect(
      ensurePrincipalEmail({
        credentialStore: store,
        fetch: async () =>
          Response.json(
            {
              error: "email_unverified",
              error_description: "authenticated user has no verified email",
            },
            { status: 403 },
          ),
      }),
    ).rejects.toMatchObject({
      code: "CLI_EMAIL_UNVERIFIED",
    } satisfies Partial<SplitchCliError>);

    expect(get()?.credential.emailBackfillUnavailableUntil).toBeUndefined();
    expect(get()?.credential.refreshToken).toBe("refresh-r1");
  });
});
