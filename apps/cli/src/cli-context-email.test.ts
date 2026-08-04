import { readFile, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli } from "./cli.js";
import { EXIT_AUTH, EXIT_OK } from "./exit-codes.js";
import { FakeCliTransport, oauthTokenMint, storedCredential } from "./test-fixtures.js";
import { cleanupTempHomes, makeTempHome } from "./test-helpers.js";

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupTempHomes();
});

describe("splitch context email backfill", () => {
  it("backfills email on context when a stored session still has the unknown placeholder", async () => {
    const { dir, credentialPath } = await makeTempHome();
    const legacy = {
      ...storedCredential(),
      principal: { userId: "user_test", email: "unknown" },
    };
    await writeFile(credentialPath, `${JSON.stringify(legacy)}\n`);
    const transport = new FakeCliTransport([oauthTokenMint()]);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    const code = await runCli(["context", "--json"], {
      credentialPath,
      cwd: dir,
      fetch: transport.fetch,
    });

    expect(code).toBe(EXIT_OK);
    const payload = JSON.parse(log.mock.calls.join("")) as {
      principal: { userId: string; email: string };
    };
    expect(payload.principal).toEqual({
      userId: "user_test",
      email: "user_test@splitch.test",
    });
    const saved = JSON.parse(await readFile(credentialPath, "utf8")) as {
      principal: { email?: string };
    };
    expect(saved.principal.email).toBe("user_test@splitch.test");
    expect(JSON.stringify(saved)).not.toContain("unknown");
  });

  it("keeps context usable when email backfill refresh fails, and does not retry while the access token is live", async () => {
    const { dir, credentialPath } = await makeTempHome();
    const liveExpiry = new Date(Date.now() + 3_600_000).toISOString();
    const legacy = {
      ...storedCredential(),
      principal: { userId: "user_test" },
      credential: {
        ...storedCredential().credential,
        accessTokenExpiresAt: liveExpiry,
      },
    };
    await writeFile(credentialPath, `${JSON.stringify(legacy)}\n`);
    const transport = new FakeCliTransport([
      {
        match: (request) => request.url.endsWith("/oauth2/token") && request.method === "POST",
        status: 500,
        body: { error: "server_error", error_description: "auth door fault" },
      },
    ]);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    const first = await runCli(["context", "--json"], {
      credentialPath,
      cwd: dir,
      fetch: transport.fetch,
    });
    expect(first).toBe(EXIT_OK);
    const payload = JSON.parse(log.mock.calls.join("")) as {
      principal: {
        userId: string;
        email?: string;
        emailUnavailableReason?: string;
      };
    };
    expect(payload.principal).toEqual({
      userId: "user_test",
      emailUnavailableReason: "backfill_unavailable",
    });

    log.mockClear();
    const second = await runCli(["context", "--json"], {
      credentialPath,
      cwd: dir,
      fetch: transport.fetch,
    });
    expect(second).toBe(EXIT_OK);
    expect(transport.requests.filter((r) => r.url.includes("/oauth2/token"))).toHaveLength(1);
    const saved = JSON.parse(await readFile(credentialPath, "utf8")) as {
      credential: { emailBackfillUnavailableUntil?: string };
    };
    expect(saved.credential.emailBackfillUnavailableUntil).toBe(liveExpiry);
  });

  it("retries email backfill after the access token rotates, so context-only users recover", async () => {
    const { dir, credentialPath } = await makeTempHome();
    const priorExpiry = new Date(Date.now() + 3_600_000).toISOString();
    const rotatedExpiry = new Date(Date.now() + 7_200_000).toISOString();
    const marked = {
      ...storedCredential(),
      principal: { userId: "user_test" },
      credential: {
        ...storedCredential().credential,
        // Miss was recorded against a prior access-token lifetime; a rotation
        // changed accessTokenExpiresAt so the marker no longer blocks retry.
        accessTokenExpiresAt: rotatedExpiry,
        emailBackfillUnavailableUntil: priorExpiry,
      },
    };
    await writeFile(credentialPath, `${JSON.stringify(marked)}\n`);
    const transport = new FakeCliTransport([oauthTokenMint()]);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    const code = await runCli(["context", "--json"], {
      credentialPath,
      cwd: dir,
      fetch: transport.fetch,
    });

    expect(code).toBe(EXIT_OK);
    expect(transport.requests.filter((r) => r.url.includes("/oauth2/token"))).toHaveLength(1);
    const payload = JSON.parse(log.mock.calls.join("")) as {
      principal: { userId: string; email: string };
    };
    expect(payload.principal).toEqual({
      userId: "user_test",
      email: "user_test@splitch.test",
    });
  });

  it("fails loud with CLI_EMAIL_UNVERIFIED when refresh reports an unverified email", async () => {
    const { dir, credentialPath } = await makeTempHome();
    const legacy = {
      ...storedCredential(),
      principal: { userId: "user_test" },
    };
    await writeFile(credentialPath, `${JSON.stringify(legacy)}\n`);
    const transport = new FakeCliTransport([
      {
        match: (request) => request.url.endsWith("/oauth2/token") && request.method === "POST",
        status: 403,
        body: {
          error: "email_unverified",
          error_description: "authenticated user has no verified email",
        },
      },
    ]);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    const code = await runCli(["context", "--json"], {
      credentialPath,
      cwd: dir,
      fetch: transport.fetch,
    });

    expect(code).toBe(EXIT_AUTH);
    expect(error.mock.calls.join(" ")).toContain("CLI_EMAIL_UNVERIFIED");
    expect(error.mock.calls.join(" ")).toContain("Verify your email");
  });
});
