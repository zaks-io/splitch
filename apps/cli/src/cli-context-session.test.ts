import { writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli } from "./cli.js";
import { EXIT_OK } from "./exit-codes.js";
import { FakeCliTransport, oauthTokenMint, storedCredential } from "./test-fixtures.js";
import { cleanupTempHomes, makeTempHome } from "./test-helpers.js";

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupTempHomes();
});

const EXPIRED = "2020-01-01T00:00:00.000Z";

async function writeExpiredCredential(credentialPath: string): Promise<void> {
  await writeFile(
    credentialPath,
    `${JSON.stringify({
      ...storedCredential(),
      credential: { ...storedCredential().credential, accessTokenExpiresAt: EXPIRED },
    })}\n`,
  );
}

/**
 * A live access token but no email on the principal: `verifySession` never
 * touches the direct-refresh path for this shape, so any exercise of
 * `mintFailureError`'s classification has to come from `ensurePrincipalEmail`'s
 * own refresh call instead (SPL-376).
 */
async function writeEmailLessLiveCredential(credentialPath: string): Promise<void> {
  const base = storedCredential();
  await writeFile(
    credentialPath,
    `${JSON.stringify({
      ...base,
      principal: { userId: base.principal.userId },
    })}\n`,
  );
}

/**
 * SPL-376: a stored credential file only proves the CLI once logged in, not
 * that the session is still live. `context` must revalidate through the same
 * refresh-grant path every other command uses (auth-token.ts) rather than
 * echoing `authenticated: true` for whatever `credentialStore.load()` returns.
 */
describe("splitch context reports the real session state (SPL-376)", () => {
  it("reports authenticated: false with the login remedy when the refresh token is dead", async () => {
    const { dir, credentialPath } = await makeTempHome();
    await writeExpiredCredential(credentialPath);
    const transport = new FakeCliTransport([
      {
        match: (request) => request.url.endsWith("/oauth2/token"),
        status: 400,
        body: { error: "invalid_grant", error_description: "refresh token is invalid or expired" },
      },
    ]);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    const code = await runCli(["context", "--json"], {
      credentialPath,
      cwd: dir,
      fetch: transport.fetch,
    });

    expect(code).toBe(EXIT_OK);
    const payload = JSON.parse(log.mock.calls.join("")) as {
      authenticated: boolean;
      nextSteps: string[];
      principal?: unknown;
    };
    expect(payload.authenticated).toBe(false);
    expect(payload.nextSteps).toEqual(["splitch login"]);
    expect(payload.principal).toBeUndefined();
  });

  it("keeps the live-session payload unchanged when an expired access token still refreshes", async () => {
    const { dir, credentialPath } = await makeTempHome();
    await writeExpiredCredential(credentialPath);
    const transport = new FakeCliTransport([oauthTokenMint()]);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    const code = await runCli(["context", "--json"], {
      credentialPath,
      cwd: dir,
      fetch: transport.fetch,
    });

    expect(code).toBe(EXIT_OK);
    const payload = JSON.parse(log.mock.calls.join("")) as {
      authenticated: boolean;
      principal: { userId: string; email: string };
      sessionUnverifiedReason?: string;
    };
    expect(payload.authenticated).toBe(true);
    expect(payload.principal).toEqual({
      userId: storedCredential().principal.userId,
      email: storedCredential().principal.email,
    });
    expect(payload.sessionUnverifiedReason).toBeUndefined();
  });

  it("reports an unverified reason instead of a false negative when the refresh endpoint is unreachable", async () => {
    const { dir, credentialPath } = await makeTempHome();
    await writeExpiredCredential(credentialPath);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    const code = await runCli(["context", "--json"], {
      credentialPath,
      cwd: dir,
      fetch: async () => {
        throw new TypeError("fetch failed");
      },
    });

    expect(code).toBe(EXIT_OK);
    const payload = JSON.parse(log.mock.calls.join("")) as {
      authenticated: boolean;
      principal: { userId: string; email: string };
      sessionUnverifiedReason?: string;
    };
    expect(payload.authenticated).toBe(true);
    expect(payload.principal).toEqual({
      userId: storedCredential().principal.userId,
      email: storedCredential().principal.email,
    });
    expect(payload.sessionUnverifiedReason).toBe("refresh_unreachable");
  });

  it("reports an unverified reason instead of a false negative when the auth service returns a 5xx (SPL-376)", async () => {
    const { dir, credentialPath } = await makeTempHome();
    await writeExpiredCredential(credentialPath);
    const transport = new FakeCliTransport([
      {
        match: (request) => request.url.endsWith("/oauth2/token"),
        status: 500,
        body: { error: "server_error", error_description: "upstream identity provider timed out" },
      },
    ]);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    const code = await runCli(["context", "--json"], {
      credentialPath,
      cwd: dir,
      fetch: transport.fetch,
    });

    expect(code).toBe(EXIT_OK);
    const payload = JSON.parse(log.mock.calls.join("")) as {
      authenticated: boolean;
      principal: { userId: string; email: string };
      sessionUnverifiedReason?: string;
      sessionUnverifiedDetail?: string;
    };
    expect(payload.authenticated).toBe(true);
    expect(payload.principal).toEqual({
      userId: storedCredential().principal.userId,
      email: storedCredential().principal.email,
    });
    expect(payload.sessionUnverifiedReason).toBe("refresh_failed");
    expect(payload.sessionUnverifiedDetail).toBe(
      "HTTP 500: server_error: upstream identity provider timed out",
    );
  });
});

/**
 * `ensurePrincipalEmail`'s own refresh call runs whenever the principal lacks
 * an email, independent of access-token expiry, so its faults reach
 * `verifySession` through a different code path than the tests above
 * (SPL-376): a proven refusal must still report `authenticated: false`, and an
 * ambiguous fault must still surface as `sessionUnverifiedReason` instead of
 * being swallowed into a bare `authenticated: true`.
 */
describe("splitch context also revalidates the email-backfill refresh call (SPL-376)", () => {
  it("reports authenticated: false when the email-backfill refresh call proves the session dead (SPL-376)", async () => {
    const { dir, credentialPath } = await makeTempHome();
    await writeEmailLessLiveCredential(credentialPath);
    const transport = new FakeCliTransport([
      {
        match: (request) => request.url.endsWith("/oauth2/token"),
        status: 400,
        body: { error: "invalid_grant", error_description: "refresh token is invalid or expired" },
      },
    ]);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    const code = await runCli(["context", "--json"], {
      credentialPath,
      cwd: dir,
      fetch: transport.fetch,
    });

    expect(code).toBe(EXIT_OK);
    const payload = JSON.parse(log.mock.calls.join("")) as {
      authenticated: boolean;
      nextSteps: string[];
      principal?: unknown;
    };
    expect(payload.authenticated).toBe(false);
    expect(payload.nextSteps).toEqual(["splitch login"]);
    expect(payload.principal).toBeUndefined();
  });

  it("reports an unverified reason instead of a bare authenticated: true when the email-backfill refresh call hits a 5xx (SPL-376)", async () => {
    const { dir, credentialPath } = await makeTempHome();
    await writeEmailLessLiveCredential(credentialPath);
    const transport = new FakeCliTransport([
      {
        match: (request) => request.url.endsWith("/oauth2/token"),
        status: 500,
        body: { error: "server_error", error_description: "upstream identity provider timed out" },
      },
    ]);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    const code = await runCli(["context", "--json"], {
      credentialPath,
      cwd: dir,
      fetch: transport.fetch,
    });

    expect(code).toBe(EXIT_OK);
    const payload = JSON.parse(log.mock.calls.join("")) as {
      authenticated: boolean;
      principal: { userId: string; emailUnavailableReason?: string };
      sessionUnverifiedReason?: string;
      sessionUnverifiedDetail?: string;
    };
    expect(payload.authenticated).toBe(true);
    expect(payload.principal.userId).toBe(storedCredential().principal.userId);
    expect(payload.sessionUnverifiedReason).toBe("refresh_failed");
    expect(payload.sessionUnverifiedDetail).toBe(
      "HTTP 500: server_error: upstream identity provider timed out",
    );
  });
});
