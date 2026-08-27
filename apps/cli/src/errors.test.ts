import { writeFile } from "node:fs/promises";
import { SplitchSdkError } from "@splitch/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli } from "./cli.js";
import {
  cliClientErrorCodes,
  cliErrorCodeForVerifyDetails,
  cliErrorCodes,
  formatCliError,
  normalizeCliError,
  SplitchCliError,
  writeCliError,
} from "./errors.js";
import { writeServerError } from "./execute-operations.js";
import { EXIT_API, EXIT_AUTH, EXIT_SCOPE, EXIT_USAGE } from "./exit-codes.js";
import { scopeResolutionStubs } from "./scope-resolution-fixtures.js";
import { FakeCliTransport, jsonError, storedCredential } from "./test-fixtures.js";
import { cleanupTempHomes, makeTempHome } from "./test-helpers.js";

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupTempHomes();
});

describe("CLI actionable error catalog", () => {
  it("extends server ErrorCode values with every CLI-only failure code", () => {
    expect(cliErrorCodes).toContain("UNAUTHORIZED");
    for (const code of cliClientErrorCodes) {
      expect(cliErrorCodes).toContain(code);
    }
  });

  it("formats one line with code, cause, and remediation", () => {
    const line = formatCliError({
      code: "CLI_USAGE_INVALID",
      causeSummary: "A required value is absent",
      remediation: "Pass the required value",
    });
    expect(line).toContain("CLI_USAGE_INVALID");
    expect(line).toContain("Remediation:");
    expect(line).not.toContain("\n");
    expect(
      new SplitchCliError({
        code: "CLI_USAGE_INVALID",
        causeSummary: "A required value is absent",
        remediation: "Pass the required value",
      }).docsUrl,
    ).toBe("https://splitch.dev/docs/error/CLI_USAGE_INVALID");
  });

  it("points every CLI-only code at its published error page", () => {
    for (const code of cliClientErrorCodes) {
      expect(
        new SplitchCliError({ code, causeSummary: "cause", remediation: "remedy" }).docsUrl,
      ).toBe(`https://splitch.dev/docs/error/${code}`);
    }
  });

  it("preserves an SDK error code and exception chain on stderr", () => {
    const original = new Error("transport rejected the request");
    const sdkError = new SplitchSdkError({
      code: "UNAUTHORIZED",
      causeSummary: "The data plane rejected the credential",
      remediation: "Replace the credential and retry",
      originalError: original,
    });
    const stderr = vi.fn();

    const normalized = normalizeCliError(sdkError);
    writeCliError({ error: stderr, log: vi.fn() }, normalized);

    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("UNAUTHORIZED"));
    expect(normalized.code).toBe("UNAUTHORIZED");
    expect(normalized.cause).toBe(sdkError);
    expect(sdkError.cause).toBe(original);
  });

  it("rejects the browser-only stale code on the server verify path", () => {
    expect(cliErrorCodeForVerifyDetails("FLAG_NOT_FOUND")).toBe("FLAG_NOT_FOUND");
    expect(cliErrorCodeForVerifyDetails(undefined)).toBe("CLI_DATA_PLANE_ERROR_CODE_MISSING");
    expect(() => cliErrorCodeForVerifyDetails("PROVIDER_NOT_READY")).toThrowError(
      expect.objectContaining({
        code: "CLI_UNEXPECTED_ERROR",
        causeSummary: expect.stringContaining("browser-only PROVIDER_NOT_READY"),
      }),
    );
  });

  it("names an unrecognized server code instead of inventing a server failure", () => {
    const stderr = vi.fn();

    writeServerError(
      { error: stderr, log: vi.fn() },
      {
        code: "FUTURE_SERVER_CODE",
        message: "The server knows about a newer failure",
        details: {},
      } as never,
      "flags_list",
    );

    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("CLI_SERVER_CODE_UNRECOGNIZED"));
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("FUTURE_SERVER_CODE"));
    expect(stderr).not.toHaveBeenCalledWith(expect.stringContaining("INTERNAL_SERVER_ERROR"));
  });
});

describe("CLI fatal stderr contract", () => {
  it("emits a stable usage code for argument parsing failures", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await runCli(["flags", "list", "--app"])).toBe(EXIT_USAGE);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("CLI_USAGE_INVALID"));
    expect(error).toHaveBeenCalledWith(expect.stringContaining("Remediation:"));
  });

  it("emits a stable scope code", async () => {
    const { dir, credentialPath } = await makeTempHome();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await runCli(["flags", "list"], { cwd: dir, credentialPath })).toBe(EXIT_SCOPE);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("CLI_SCOPE_UNRESOLVED"));
  });

  it("emits a stable auth code", async () => {
    const { dir, credentialPath } = await makeTempHome();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await runCli(["flags", "list", "--app", "app_1"], { cwd: dir, credentialPath })).toBe(
      EXIT_AUTH,
    );
    expect(error).toHaveBeenCalledWith(expect.stringContaining("CLI_NOT_AUTHENTICATED"));
  });

  it("enriches the server refusal on stdout while keeping the prose on stderr", async () => {
    const { dir, credentialPath } = await makeTempHome();
    await writeFile(credentialPath, `${JSON.stringify(storedCredential())}\n`);
    const serverError = jsonError("APPROVAL_REVIEW_REQUIRED", "approval review required");
    const transport = new FakeCliTransport([
      ...scopeResolutionStubs(),
      {
        match: (request) => request.url.includes("/flags"),
        status: 409,
        body: serverError,
      },
    ]);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(
      await runCli(["flags", "list", "--json", "--app", "app_1"], {
        cwd: dir,
        credentialPath,
        fetch: transport.fetch,
      }),
    ).toBe(EXIT_API);
    // `message` is the server's text verbatim: the same refusal read over MCP
    // must compare equal (scripts/lib/cli-mcp-shared-operation.ts).
    expect(JSON.parse(log.mock.calls.join(""))).toEqual({
      code: "APPROVAL_REVIEW_REQUIRED",
      message: serverError.message,
      remediation: expect.stringContaining("apr_01J00000000000000000000000"),
      docsUrl: "https://splitch.dev/docs/error/APPROVAL_REVIEW_REQUIRED",
      details: serverError.details,
    });
    expect(error).toHaveBeenCalledWith(expect.stringContaining("APPROVAL_REVIEW_REQUIRED"));
    expect(error).toHaveBeenCalledWith(expect.stringContaining("Remediation:"));
  });

  it("gives a CLI-local refusal the same stdout shape as a server refusal", async () => {
    const { dir, credentialPath } = await makeTempHome();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    expect(
      await runCli(["flags", "list", "--json", "--app", "app_1"], { cwd: dir, credentialPath }),
    ).toBe(EXIT_AUTH);
    expect(JSON.parse(log.mock.calls.join(""))).toEqual({
      code: "CLI_NOT_AUTHENTICATED",
      message: expect.any(String),
      remediation: expect.stringContaining("splitch login"),
      docsUrl: "https://splitch.dev/docs/error/CLI_NOT_AUTHENTICATED",
      details: null,
    });
  });

  /**
   * `--json` is read from raw argv so the sites that run before (or instead of)
   * a successful parse answer in the same shape. The human usage block would
   * make stdout unparseable, so it is suppressed rather than appended.
   */
  it("answers the pre-parse error sites in JSON and drops the usage block", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    expect(await runCli(["nonsense", "list", "--json"])).toBe(EXIT_USAGE);
    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.parse(log.mock.calls.join(""))).toEqual({
      code: "CLI_USAGE_INVALID",
      message: expect.stringContaining("nonsense"),
      remediation: expect.any(String),
      docsUrl: "https://splitch.dev/docs/error/CLI_USAGE_INVALID",
      details: null,
    });
  });

  it("leaves the human path byte-identical without --json", async () => {
    const { dir, credentialPath } = await makeTempHome();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(await runCli(["flags", "list", "--app", "app_1"], { cwd: dir, credentialPath })).toBe(
      EXIT_AUTH,
    );
    expect(log).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(expect.stringContaining("CLI_NOT_AUTHENTICATED"));
  });

  it("wraps credential-store failures with a stable code", async () => {
    const { dir, credentialPath } = await makeTempHome();
    await writeFile(credentialPath, "not-json\n");
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(await runCli(["flags", "list", "--app", "app_1"], { cwd: dir, credentialPath })).toBe(
      EXIT_USAGE,
    );
    expect(error).toHaveBeenCalledWith(expect.stringContaining("CLI_CREDENTIAL_STORE_FAILED"));
  });
});
