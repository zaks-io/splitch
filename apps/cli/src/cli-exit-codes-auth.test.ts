import { access, readFile, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "./cli.js";
import { EXIT_API, EXIT_AUTH, EXIT_OK } from "./exit-codes.js";
import {
  authHeader,
  clientKeyMaterial,
  deviceAuthorizationResponse,
  deviceTokenResponse,
  FakeCliTransport,
  jsonError,
  RefreshRetryTransport,
  storedCredential,
  verifyResolutionDetails,
} from "./test-fixtures.js";
import { cleanupTempHomes, makeTempHome } from "./test-helpers.js";

afterEach(async () => {
  await cleanupTempHomes();
});

describe("login exit code", () => {
  it("login returns 0 and stores credentials", async () => {
    const { credentialPath } = await makeTempHome();
    const transport = new FakeCliTransport([
      {
        match: (request) => request.url.endsWith("/oauth2/device_authorization"),
        status: 200,
        body: deviceAuthorizationResponse(),
      },
      {
        match: (request) =>
          request.url.endsWith("/oauth2/token") && request.body?.grant_type?.includes("device"),
        status: 200,
        body: deviceTokenResponse(),
      },
    ]);

    const code = await runCli(["login", "--json"], { credentialPath, fetch: transport.fetch });
    expect(code).toBe(EXIT_OK);
    const saved = JSON.parse(await readFile(credentialPath, "utf8")) as {
      credential: { refreshToken: string };
    };
    expect(saved.credential.refreshToken).toBe("fixture-refresh-token");
  });
});

describe("logout exit code", () => {
  it("logout removes credentials so the next command fails as logged out", async () => {
    const { credentialPath } = await makeTempHome();
    await writeFile(credentialPath, `${JSON.stringify(storedCredential())}\n`);
    const transport = new FakeCliTransport([
      {
        match: (request) => request.url.endsWith("/oauth2/revoke"),
        status: 200,
        body: {},
      },
    ]);

    const logoutCode = await runCli(["logout", "--json"], {
      credentialPath,
      fetch: transport.fetch,
    });
    expect(logoutCode).toBe(EXIT_OK);
    await expect(access(credentialPath, constants.F_OK)).rejects.toThrow();

    const listCode = await runCli(["flags", "list", "--json", "--app", "app_1"], {
      credentialPath,
      fetch: transport.fetch,
    });
    expect(listCode).toBe(EXIT_AUTH);
  });
});

describe("flags verify transport", () => {
  it("flags verify uses the Client Key on the data-plane transport, not the control-plane token", async () => {
    const { credentialPath } = await makeTempHome();
    await writeFile(credentialPath, `${JSON.stringify(storedCredential())}\n`);
    const transport = new FakeCliTransport([
      {
        match: (request) => request.url.includes("/client-key"),
        status: 200,
        body: {
          keyId: "ck_1",
          appId: "app_1",
          environmentId: "env_1",
          keyMaterial: clientKeyMaterial,
          isOriginOpen: true,
          createdAt: "2026-07-03T00:00:00.000Z",
        },
      },
      {
        match: (request) => request.url.includes("/api/sdk/verify"),
        status: 200,
        body: verifyResolutionDetails,
      },
    ]);

    const code = await runCli(
      [
        "flags",
        "verify",
        "--json",
        "--app",
        "app_1",
        "--env",
        "env_1",
        "flag_1",
        "--targeting-key",
        "user-1",
      ],
      { credentialPath, fetch: transport.fetch },
    );

    expect(code).toBe(EXIT_OK);
    const clientKeyCall = transport.requests.find((request) => request.url.includes("/client-key"));
    const verifyCall = transport.requests.find((request) =>
      request.url.includes("/api/sdk/verify"),
    );
    expect(clientKeyCall?.authorization).toBe(authHeader());
    expect(verifyCall?.authorization).toBe(`Bearer ${clientKeyMaterial}`);
    expect(verifyCall?.authorization).not.toBe(authHeader());
  });

  it("flags verify returns EXIT_API when SDK reason is ERROR", async () => {
    const { credentialPath } = await makeTempHome();
    await writeFile(credentialPath, `${JSON.stringify(storedCredential())}\n`);
    const transport = new FakeCliTransport([
      {
        match: (request) => request.url.includes("/client-key"),
        status: 200,
        body: {
          keyId: "ck_1",
          appId: "app_1",
          environmentId: "env_1",
          keyMaterial: clientKeyMaterial,
          isOriginOpen: true,
          createdAt: "2026-07-03T00:00:00.000Z",
        },
      },
      {
        match: (request) => request.url.includes("/api/sdk/verify"),
        status: 404,
        body: jsonError("FLAG_NOT_FOUND", "flag not found"),
      },
    ]);

    const code = await runCli(
      [
        "flags",
        "verify",
        "--json",
        "--app",
        "app_1",
        "--env",
        "env_1",
        "missing_flag",
        "--targeting-key",
        "user-1",
      ],
      { credentialPath, fetch: transport.fetch },
    );

    expect(code).toBe(EXIT_API);
  });
});

describe("api and auth error exit codes", () => {
  it("returns EXIT_API for control-plane ErrorResponse bodies", async () => {
    const { credentialPath } = await makeTempHome();
    await writeFile(credentialPath, `${JSON.stringify(storedCredential())}\n`);
    const transport = new FakeCliTransport([
      {
        match: (request) => request.url.includes("/flags"),
        status: 409,
        body: jsonError("CONFIRMATION_REQUIRED", "confirmation required"),
      },
    ]);

    const code = await runCli(["flags", "list", "--json", "--app", "app_1"], {
      credentialPath,
      fetch: transport.fetch,
    });
    expect(code).toBe(EXIT_API);
  });

  it("silently refreshes on 401 and only fails auth when refresh fails", async () => {
    const { credentialPath } = await makeTempHome();
    await writeFile(credentialPath, `${JSON.stringify(storedCredential())}\n`);
    const transport = new RefreshRetryTransport();

    const code = await runCli(["flags", "list", "--json", "--app", "app_1"], {
      credentialPath,
      fetch: transport.fetch,
    });
    expect(code).toBe(EXIT_OK);
    expect(transport.requests.some((request) => request.url.endsWith("/oauth2/token"))).toBe(true);
    expect(transport.flagCalls).toBe(2);
  });

  it("returns EXIT_AUTH when refresh fails after a 401", async () => {
    const { credentialPath } = await makeTempHome();
    const expired = {
      ...storedCredential(),
      credential: {
        ...storedCredential().credential,
        accessTokenExpiresAt: "2020-01-01T00:00:00.000Z",
      },
    };
    await writeFile(credentialPath, `${JSON.stringify(expired)}\n`);
    const transport = new FakeCliTransport([
      {
        match: (request) => request.url.endsWith("/oauth2/token"),
        status: 400,
        body: { error: "invalid_grant" },
      },
    ]);

    const code = await runCli(["flags", "list", "--json", "--app", "app_1"], {
      credentialPath,
      fetch: transport.fetch,
    });
    expect(code).toBe(EXIT_AUTH);
  });
});
