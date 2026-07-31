import { writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli } from "./cli.js";
import { cliClientErrorCodes, cliErrorCodes, formatCliError, SplitchCliError } from "./errors.js";
import { EXIT_API, EXIT_AUTH, EXIT_SCOPE, EXIT_USAGE } from "./exit-codes.js";
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
      cause: "A required value is absent",
      remediation: "Pass the required value",
    });
    expect(line).toContain("CLI_USAGE_INVALID");
    expect(line).toContain("Remediation:");
    expect(line).not.toContain("\n");
    expect(
      new SplitchCliError({
        code: "CLI_USAGE_INVALID",
        cause: "A required value is absent",
        remediation: "Pass the required value",
      }).docsUrl,
    ).toBeUndefined();
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

  it("preserves JSON stdout while writing the server code to stderr", async () => {
    const { dir, credentialPath } = await makeTempHome();
    await writeFile(credentialPath, `${JSON.stringify(storedCredential())}\n`);
    const serverError = jsonError("APPROVAL_REVIEW_REQUIRED", "approval review required");
    const transport = new FakeCliTransport([
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
    expect(log).toHaveBeenCalledWith(JSON.stringify(serverError));
    expect(error).toHaveBeenCalledWith(expect.stringContaining("APPROVAL_REVIEW_REQUIRED"));
    expect(error).toHaveBeenCalledWith(expect.stringContaining("Remediation:"));
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
