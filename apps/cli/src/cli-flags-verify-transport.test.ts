import { writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli } from "./cli.js";
import { EXIT_API, EXIT_OK, EXIT_USAGE } from "./exit-codes.js";
import {
  authHeader,
  clientKeyMaterial,
  FakeCliTransport,
  jsonError,
  storedCredential,
  verifyResolutionDetails,
} from "./test-fixtures.js";
import { cleanupTempHomes, makeTempHome } from "./test-helpers.js";

/**
 * `flags verify` is the one command that presents two different credentials in
 * one invocation: the control-plane token to fetch the Environment's Client Key,
 * then that Client Key on the data plane. Which credential reaches which origin
 * is the whole point, so it is asserted per request rather than per exit code.
 */

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupTempHomes();
});

describe("flags verify transport", () => {
  it("names the positional as a Flag key in the coded usage error", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    const code = await runCli([
      "flags",
      "verify",
      "--app",
      "app_1",
      "--env",
      "env_1",
      "--targeting-key",
      "user-1",
    ]);

    expect(code).toBe(EXIT_USAGE);
    expect(error).toHaveBeenCalledWith(
      "CLI_USAGE_INVALID: Cause: flags verify requires a Flag key. Remediation: Pass the Flag key as the first positional argument.",
    );
  });

  it("uses the Client Key on the data-plane transport, not the control-plane token", async () => {
    const { credentialPath } = await makeTempHome();
    await writeFile(credentialPath, `${JSON.stringify(storedCredential())}\n`);
    const transport = new FakeCliTransport([
      clientKeyStub(),
      {
        match: (request) => request.url.includes("/api/sdk/verify"),
        status: 200,
        body: verifyResolutionDetails,
      },
    ]);

    const code = await runCli(verifyArgs("checkout"), {
      credentialPath,
      fetch: transport.fetch,
    });

    expect(code).toBe(EXIT_OK);
    const clientKeyCall = transport.requests.find((request) => request.url.includes("/client-key"));
    const verifyCall = transport.requests.find((request) =>
      request.url.includes("/api/sdk/verify"),
    );
    expect(clientKeyCall?.authorization).toBe(authHeader());
    expect(verifyCall?.authorization).toBe(`Bearer ${clientKeyMaterial}`);
    expect(verifyCall?.authorization).not.toBe(authHeader());
    expect(verifyCall?.body).toMatchObject({ flagKey: "checkout" });
  });

  it("returns EXIT_API when the SDK reason is ERROR", async () => {
    const { credentialPath } = await makeTempHome();
    await writeFile(credentialPath, `${JSON.stringify(storedCredential())}\n`);
    const transport = new FakeCliTransport([
      clientKeyStub(),
      {
        match: (request) => request.url.includes("/api/sdk/verify"),
        status: 404,
        body: jsonError("FLAG_NOT_FOUND", "flag not found"),
      },
    ]);

    const code = await runCli(verifyArgs("missing-flag"), {
      credentialPath,
      fetch: transport.fetch,
    });

    expect(code).toBe(EXIT_API);
  });
});

function clientKeyStub() {
  return {
    match: (request: { url: string }) => request.url.includes("/client-key"),
    status: 200,
    body: {
      keyId: "ck_1",
      appId: "app_1",
      environmentId: "env_1",
      keyMaterial: clientKeyMaterial,
      isOriginOpen: true,
      createdAt: "2026-07-03T00:00:00.000Z",
    },
  };
}

function verifyArgs(flagKey: string): string[] {
  return [
    "flags",
    "verify",
    "--json",
    "--app",
    "app_1",
    "--env",
    "env_1",
    flagKey,
    "--targeting-key",
    "user-1",
  ];
}
