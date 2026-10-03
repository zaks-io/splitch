import { readFileSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli } from "./cli.js";
import { EXIT_API, EXIT_OK, EXIT_USAGE } from "./exit-codes.js";
import { scopeResolutionStubs } from "./scope-resolution-fixtures.js";
import { FakeCliTransport, flagRecord, storedCredential } from "./test-fixtures.js";
import { cleanupTempHomes, makeTempHome } from "./test-helpers.js";

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupTempHomes();
});

/**
 * Incident 2026-10-02: the Worker began requiring a body field one hour after a
 * CLI release, and that CLI refused to send it even through --body-json because
 * it judged the body against its own bundled contract first. The Worker is the
 * only judge of a request body; these pin that an older CLI can always reach it.
 */
const installedVersion = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    version: string;
  }
).version;

const newerApiBody = {
  key: "checkout",
  name: "Checkout",
  variants: [{ name: "on", value: true, isDefault: true }],
  fieldFromNewerApi: { mode: "ops" },
};

const flagsCreateArgs = [
  "flags",
  "create",
  "--app",
  "app_1",
  "--json",
  "--body-json",
  JSON.stringify(newerApiBody),
] as const;

async function loggedInHome() {
  const home = await makeTempHome();
  writeFileSync(home.credentialPath, `${JSON.stringify(storedCredential())}\n`);
  return home;
}

function flagsCreateTransport(status: number, body: unknown): FakeCliTransport {
  return new FakeCliTransport([
    ...scopeResolutionStubs(),
    {
      match: (request) => request.method === "POST" && request.url.endsWith("/apps/app_1/flags"),
      status,
      body,
    },
  ]);
}

function createRequests(transport: FakeCliTransport) {
  return transport.requests.filter(
    (request) => request.method === "POST" && request.url.endsWith("/apps/app_1/flags"),
  );
}

describe("--body-json reaches the server unjudged", () => {
  it("sends a key the bundled contract does not know, unchanged", async () => {
    const { dir, credentialPath } = await loggedInHome();
    const transport = flagsCreateTransport(201, flagRecord);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    const code = await runCli(flagsCreateArgs, {
      cwd: dir,
      credentialPath,
      fetch: transport.fetch,
      env: {},
    });

    expect(code).toBe(EXIT_OK);
    const [request] = createRequests(transport);
    expect(request?.body).toEqual({
      appId: "app_1",
      ...newerApiBody,
      idempotency_key: expect.any(String),
    });
  });

  it("surfaces the server VALIDATION_ERROR as-is", async () => {
    const { dir, credentialPath } = await loggedInHome();
    const serverError = {
      code: "VALIDATION_ERROR",
      message: "request failed schema validation",
      details: {
        issues: [{ path: ["fieldFromNewerApi", "mode"], message: "Invalid option" }],
      },
    };
    const transport = flagsCreateTransport(400, serverError);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    const code = await runCli(flagsCreateArgs, {
      cwd: dir,
      credentialPath,
      fetch: transport.fetch,
      env: {},
    });

    expect(code).toBe(EXIT_API);
    expect(createRequests(transport)).toHaveLength(1);
    expect(JSON.parse(log.mock.calls.join(""))).toEqual({
      code: "VALIDATION_ERROR",
      message: serverError.message,
      remediation:
        "Correct the fields named in details.issues and retry; splitch flags create --help prints the request body schema.",
      docsUrl: "https://splitch.dev/docs/error/VALIDATION_ERROR",
      details: serverError.details,
      outcome: expect.any(String),
    });
    expect(error).toHaveBeenCalledWith(expect.stringContaining("VALIDATION_ERROR"));
  });
});

describe("an unrecognized flag names the version skew", () => {
  it("gives the installed version, the upgrade command, and the --body-json route", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const fetch = vi.fn<typeof globalThis.fetch>();

    const code = await runCli(
      ["flags", "create", "--app", "app_1", "--retire-after", "30d", "--json"],
      { fetch, env: {} },
    );

    expect(code).toBe(EXIT_USAGE);
    expect(fetch).not.toHaveBeenCalled();
    const refusal = JSON.parse(log.mock.calls.join("")) as { code: string; remediation: string };
    expect(refusal.code).toBe("CLI_USAGE_INVALID");
    expect(refusal.remediation).toBe(
      "Drop --retire-after, or run splitch flags create --help to list the accepted flags. " +
        `The installed CLI (${installedVersion}) may be older than the API: upgrade with ` +
        "npm install --global @splitch/cli@latest. " +
        "To send a field this version has no typed flag for, pass it in --body-json.",
    );
  });

  it("omits the --body-json route for a command that takes no body", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    expect(await runCli(["health", "--retire-after", "30d", "--json"], { env: {} })).toBe(
      EXIT_USAGE,
    );

    const refusal = JSON.parse(log.mock.calls.join("")) as { remediation: string };
    expect(refusal.remediation).toContain(`The installed CLI (${installedVersion})`);
    expect(refusal.remediation).toContain("npm install --global @splitch/cli@latest");
    expect(refusal.remediation).not.toContain("--body-json");
  });
});
