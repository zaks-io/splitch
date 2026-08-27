import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import open from "open";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCli } from "./cli.js";
import { EXIT_OK } from "./exit-codes.js";
import {
  deviceAuthorizationResponse,
  deviceTokenResponse,
  FakeCliTransport,
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

function loginTransport(authorization: unknown): FakeCliTransport {
  return new FakeCliTransport([
    {
      match: (request) => request.url.endsWith("/oauth2/device_authorization"),
      status: 200,
      body: authorization,
    },
    {
      match: (request) => request.url.endsWith("/oauth2/token"),
      status: 200,
      body: deviceTokenResponse(),
    },
  ]);
}

describe("login browser approval", () => {
  it("opens the base verification URI before polling when no complete URI is returned", async () => {
    const { credentialPath } = await makeTempHome();
    const { verification_uri_complete: _complete, ...authorization } =
      deviceAuthorizationResponse();
    const transport = loginTransport(authorization);
    vi.mocked(open).mockImplementationOnce(async () => {
      expect(transport.requests).toHaveLength(1);
      return undefined as never;
    });

    expect(
      await runCli(["login", "--json"], {
        credentialPath,
        fetch: transport.fetch,
        platformTarget: "production",
      }),
    ).toBe(EXIT_OK);

    expect(open).toHaveBeenCalledOnce();
    expect(open).toHaveBeenCalledWith("https://auth.splitch.dev/device");
  });

  it("continues login with a visible manual fallback when the browser cannot open", async () => {
    const { credentialPath } = await makeTempHome();
    const transport = loginTransport(deviceAuthorizationResponse());
    vi.mocked(open).mockRejectedValueOnce(new Error("no browser available"));
    const stderrSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(
      await runCli(["login", "--json"], {
        credentialPath,
        fetch: transport.fetch,
        platformTarget: "production",
      }),
    ).toBe(EXIT_OK);

    const stderr = stderrSpy.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(stderr).toContain("visit https://auth.splitch.dev/device and enter code ABCD-1234");
    expect(stderr).toContain("Could not open the browser automatically");
    await expect(readFile(credentialPath, "utf8")).resolves.toContain("fixture-refresh-token");
  });
});

describe("login device URL origin binding", () => {
  it.each([
    ["malformed base URI", { verification_uri: "not a URL", verification_uri_complete: undefined }],
    [
      "unsupported base URI",
      { verification_uri: "file:///tmp/approval", verification_uri_complete: undefined },
    ],
    ["unsupported complete URI", { verification_uri_complete: "javascript:alert(1)" }],
    ["foreign-origin URI", { verification_uri: "https://evil.test/device" }],
    [
      "credential-bearing URI",
      {
        verification_uri: "https://user:pass@auth.splitch.dev/device",
        verification_uri_complete: undefined,
      },
    ],
    [
      "port-changing URI",
      {
        verification_uri: "https://auth.splitch.dev:8443/device",
        verification_uri_complete: undefined,
      },
    ],
    [
      "downgrade URI",
      { verification_uri: "http://auth.splitch.dev/device", verification_uri_complete: undefined },
    ],
  ])("rejects an unsafe verification URI before opening or polling: %s", async (_case, override) => {
    const { credentialPath } = await makeTempHome();
    const transport = new FakeCliTransport([
      {
        match: (request) => request.url.endsWith("/oauth2/device_authorization"),
        status: 200,
        body: { ...deviceAuthorizationResponse(), ...override },
      },
    ]);
    const stderrSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(
      await runCli(["login", "--json"], {
        credentialPath,
        fetch: transport.fetch,
        platformTarget: "production",
      }),
    ).not.toBe(EXIT_OK);

    expect(open).not.toHaveBeenCalled();
    expect(transport.requests).toHaveLength(1);
    expect(stderrSpy.mock.calls.join(" ")).toContain("CLI_DEVICE_AUTHORIZATION_FAILED");
    expect(stderrSpy.mock.calls.join(" ")).not.toContain("user:pass");
    await expect(access(credentialPath, constants.F_OK)).rejects.toThrow();
  });

  it("opens a valid URL on an overridden configured Auth origin", async () => {
    const { credentialPath } = await makeTempHome();
    const transport = loginTransport({
      ...deviceAuthorizationResponse(),
      verification_uri: "https://auth.example.dev/device",
      verification_uri_complete: "https://auth.example.dev/device?user_code=ABCD-1234",
    });

    expect(
      await runCli(["login", "--json"], {
        credentialPath,
        fetch: transport.fetch,
        platformTarget: "production",
        authBaseUrl: "https://auth.example.dev",
      }),
    ).toBe(EXIT_OK);

    expect(open).toHaveBeenCalledWith("https://auth.example.dev/device?user_code=ABCD-1234");
  });

  it("opens a local HTTP device URL only on the explicit local target", async () => {
    const { credentialPath } = await makeTempHome();
    const transport = loginTransport({
      ...deviceAuthorizationResponse(),
      verification_uri: "http://127.0.0.1:8789/device",
      verification_uri_complete: undefined,
    });

    expect(
      await runCli(["login", "--json"], {
        credentialPath,
        fetch: transport.fetch,
        platformTarget: "local",
      }),
    ).toBe(EXIT_OK);

    expect(open).toHaveBeenCalledWith("http://127.0.0.1:8789/device");
  });
});
