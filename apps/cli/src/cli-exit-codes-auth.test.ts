import { constants } from "node:fs";
import { access, readFile, writeFile } from "node:fs/promises";
import open from "open";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCli } from "./cli.js";
import { EXIT_API, EXIT_AUTH, EXIT_OK } from "./exit-codes.js";
import {
  deviceAuthorizationResponse,
  deviceTokenResponse,
  FakeCliTransport,
  jsonError,
  RefreshRetryTransport,
  storedCredential,
} from "./test-fixtures.js";
import { cleanupTempHomes, makeTempHome } from "./test-helpers.js";

vi.mock("open", () => ({ default: vi.fn() }));

beforeEach(() => {
  vi.mocked(open).mockReset();
  vi.mocked(open).mockResolvedValue(undefined as never);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupTempHomes();
});

describe("login exit code", () => {
  it("passes an App slug as a selector and stores the canonical App ID", async () => {
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

    const code = await runCli(["login", "--json", "--app", "checkout-app"], {
      credentialPath,
      fetch: transport.fetch,
    });
    expect(code).toBe(EXIT_OK);
    expect(open).toHaveBeenCalledOnce();
    expect(open).toHaveBeenCalledWith("https://auth.test/device?user_code=ABCD-1234");
    expect(transport.requests.map((request) => request.body?.app)).toEqual([
      "checkout-app",
      undefined,
    ]);
    expect(transport.requests.some((request) => request.body?.scope !== undefined)).toBe(false);
    const saved = JSON.parse(await readFile(credentialPath, "utf8")) as {
      credential: { refreshToken: string; selectedAppId: string };
    };
    expect(saved.credential.refreshToken).toBe("fixture-refresh-token");
    expect(saved.credential.selectedAppId).toBe("app_1");
  });
});

describe("login exit code", () => {
  it("names the logged-in principal by its user id and stores no fabricated identity", async () => {
    // The auth port returns the opaque user_id plus the verified email so the
    // CLI never has to invent a placeholder like `email: "unknown"`.
    const { credentialPath } = await makeTempHome();
    const transport = new FakeCliTransport([
      {
        match: (request) => request.url.endsWith("/oauth2/device_authorization"),
        status: 200,
        body: deviceAuthorizationResponse(),
      },
      {
        match: (request) => request.url.endsWith("/oauth2/token"),
        status: 200,
        body: deviceTokenResponse(),
      },
    ]);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(await runCli(["login"], { credentialPath, fetch: transport.fetch })).toBe(EXIT_OK);

    expect(error.mock.calls.join(" ")).toContain("Logged in as user_test.");
    const saved = await readFile(credentialPath, "utf8");
    expect(JSON.parse(saved).principal).toEqual({
      userId: "user_test",
      email: "user_test@splitch.test",
    });
    expect(saved).not.toContain("unknown");
  });

  it("fails loud when the token response carries no identity instead of storing a placeholder", async () => {
    const { credentialPath } = await makeTempHome();
    const { user_id: _userId, ...anonymousToken } = deviceTokenResponse();
    const transport = new FakeCliTransport([
      {
        match: (request) => request.url.endsWith("/oauth2/device_authorization"),
        status: 200,
        body: deviceAuthorizationResponse(),
      },
      {
        match: (request) => request.url.endsWith("/oauth2/token"),
        status: 200,
        body: anonymousToken,
      },
    ]);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(await runCli(["login"], { credentialPath, fetch: transport.fetch })).not.toBe(EXIT_OK);

    expect(error.mock.calls.join(" ")).toContain("CLI_DEVICE_TOKEN_EXCHANGE_FAILED");
    // Nothing half-written: a later command must not find a nameless session.
    await expect(access(credentialPath, constants.F_OK)).rejects.toThrow();
  });

  it("logs in with no App at all and stores an unbound cold-start session", async () => {
    const { credentialPath } = await makeTempHome();
    const { app_id: _appId, ...appLessToken } = deviceTokenResponse();
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
        body: appLessToken,
      },
    ]);

    const code = await runCli(["login", "--json"], {
      credentialPath,
      cwd: (await makeTempHome()).dir,
      fetch: transport.fetch,
    });
    expect(code).toBe(EXIT_OK);
    expect(transport.requests[0]?.body?.app).toBeUndefined();
    const saved = JSON.parse(await readFile(credentialPath, "utf8")) as {
      credential: { accessTokenBinding: string; selectedAppId?: string };
    };
    expect(saved.credential.accessTokenBinding).toBe("");
    expect(saved.credential.selectedAppId).toBeUndefined();
  });

  it("surfaces the OAuth error body when device authorization fails", async () => {
    const { credentialPath } = await makeTempHome();
    const transport = new FakeCliTransport([
      {
        match: (request) => request.url.endsWith("/oauth2/device_authorization"),
        status: 401,
        body: { error: "invalid_client", error_description: "Unknown client." },
      },
    ]);
    const stderrSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const code = await runCli(["login", "--json"], {
      credentialPath,
      cwd: (await makeTempHome()).dir,
      fetch: transport.fetch,
    });
    expect(code).not.toBe(EXIT_OK);
    const stderr = stderrSpy.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(stderr).toContain("invalid_client");
    expect(stderr).toContain("Unknown client.");
  });
});

describe("version flag", () => {
  it("prints the package version instead of demanding a value", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const code = await runCli(["--version"]);
    expect(code).toBe(EXIT_OK);
    expect(logSpy).toHaveBeenCalledWith(expect.stringMatching(/^\d+\.\d+\.\d+/));
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

describe("api and auth error exit codes", () => {
  it("returns EXIT_API for control-plane ErrorResponse bodies", async () => {
    const { credentialPath } = await makeTempHome();
    await writeFile(credentialPath, `${JSON.stringify(storedCredential())}\n`);
    const transport = new FakeCliTransport([
      {
        match: (request) => request.url.includes("/flags"),
        status: 409,
        body: jsonError("APPROVAL_REVIEW_REQUIRED", "approval review required"),
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
