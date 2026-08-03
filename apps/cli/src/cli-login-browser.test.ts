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

describe("login browser approval", () => {
  it("opens the base verification URI before polling when no complete URI is returned", async () => {
    const { credentialPath } = await makeTempHome();
    const { verification_uri_complete: _complete, ...authorization } =
      deviceAuthorizationResponse();
    const transport = new FakeCliTransport([
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
    vi.mocked(open).mockImplementationOnce(async () => {
      expect(transport.requests).toHaveLength(1);
      return undefined as never;
    });

    expect(await runCli(["login", "--json"], { credentialPath, fetch: transport.fetch })).toBe(
      EXIT_OK,
    );

    expect(open).toHaveBeenCalledOnce();
    expect(open).toHaveBeenCalledWith("https://auth.test/device");
  });

  it("continues login with a visible manual fallback when the browser cannot open", async () => {
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
    vi.mocked(open).mockRejectedValueOnce(new Error("no browser available"));
    const stderrSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(await runCli(["login", "--json"], { credentialPath, fetch: transport.fetch })).toBe(
      EXIT_OK,
    );

    const stderr = stderrSpy.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(stderr).toContain("visit https://auth.test/device and enter code ABCD-1234");
    expect(stderr).toContain("Could not open the browser automatically");
    await expect(readFile(credentialPath, "utf8")).resolves.toContain("fixture-refresh-token");
  });

  it.each([
    ["malformed base URI", { verification_uri: "not a URL", verification_uri_complete: undefined }],
    [
      "unsupported base URI",
      { verification_uri: "file:///tmp/approval", verification_uri_complete: undefined },
    ],
    ["unsupported complete URI", { verification_uri_complete: "javascript:alert(1)" }],
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

    expect(await runCli(["login", "--json"], { credentialPath, fetch: transport.fetch })).not.toBe(
      EXIT_OK,
    );

    expect(open).not.toHaveBeenCalled();
    expect(transport.requests).toHaveLength(1);
    expect(stderrSpy.mock.calls.join(" ")).toContain("CLI_DEVICE_AUTHORIZATION_FAILED");
    await expect(access(credentialPath, constants.F_OK)).rejects.toThrow();
  });
});
