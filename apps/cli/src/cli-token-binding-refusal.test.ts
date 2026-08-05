import { writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli } from "./cli.js";
import { EXIT_AUTH, EXIT_SCOPE } from "./exit-codes.js";
import { FakeCliTransport, storedCredential } from "./test-fixtures.js";
import { cleanupTempHomes, makeTempHome } from "./test-helpers.js";

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupTempHomes();
});

async function writeExpiredCredential(credentialPath: string): Promise<void> {
  const expired = {
    ...storedCredential(),
    credential: {
      ...storedCredential().credential,
      accessTokenExpiresAt: "2020-01-01T00:00:00.000Z",
    },
  };
  await writeFile(credentialPath, `${JSON.stringify(expired)}\n`);
}

describe("token-binding refusal vs session expiry (SPL-299)", () => {
  it("keeps CLI_SESSION_EXPIRED with re-login remediation when the refresh token is dead", async () => {
    const { credentialPath } = await makeTempHome();
    await writeExpiredCredential(credentialPath);
    const transport = new FakeCliTransport([
      {
        match: (request) => request.url.endsWith("/oauth2/token"),
        status: 400,
        body: {
          error: "invalid_grant",
          error_description: "refresh token is invalid or expired",
        },
      },
    ]);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    const code = await runCli(["flags", "list", "--json", "--app", "app_1"], {
      credentialPath,
      fetch: transport.fetch,
    });

    expect(code).toBe(EXIT_AUTH);
    const stderr = error.mock.calls.join(" ");
    expect(stderr).toContain("CLI_SESSION_EXPIRED");
    expect(stderr).toContain("refresh token is invalid or expired");
    expect(stderr.toLowerCase()).toContain("login");
    expect(stderr).not.toContain("CLI_TOKEN_BINDING_REFUSED");
  });

  it("reports CLI_TOKEN_BINDING_REFUSED for an app-binding membership refusal", async () => {
    const { credentialPath } = await makeTempHome();
    await writeExpiredCredential(credentialPath);
    const reason = "selected App is not authorized by live membership";
    const transport = new FakeCliTransport([
      {
        match: (request) => request.url.endsWith("/oauth2/token"),
        status: 400,
        body: { error: "invalid_grant", error_description: reason },
      },
    ]);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    const code = await runCli(["flags", "list", "--json", "--app", "app_1"], {
      credentialPath,
      fetch: transport.fetch,
    });

    expect(code).toBe(EXIT_SCOPE);
    const stderr = error.mock.calls.join(" ");
    expect(stderr).toContain("CLI_TOKEN_BINDING_REFUSED");
    expect(stderr).toContain(reason);
    expect(stderr).not.toContain("CLI_SESSION_EXPIRED");
    expect(stderr.toLowerCase()).not.toMatch(/log ?in|authenticate/);
  });
});
