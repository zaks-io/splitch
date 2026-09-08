import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli } from "./cli.js";
import { EXIT_OK, EXIT_USAGE } from "./exit-codes.js";
import { scopeResolutionStubs } from "./scope-resolution-fixtures.js";
import { FakeCliTransport, storedCredential } from "./test-fixtures.js";
import { cleanupTempHomes, makeTempHome } from "./test-helpers.js";

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupTempHomes();
});

const SECRET = "sk_live_do_not_log_me";

const CREATED_KEY = {
  credential: {
    keyId: "key_1",
    appId: "app_1",
    environmentId: "env_1",
    scopes: ["evaluate"],
    createdAt: "2026-08-26T00:00:00.000Z",
  },
  value: SECRET,
};

function apiKeyTransport(): FakeCliTransport {
  return new FakeCliTransport([
    ...scopeResolutionStubs(),
    {
      match: (request) => request.url.includes("/api-keys"),
      status: 201,
      body: CREATED_KEY,
    },
  ]);
}

async function createKeyInto(outputFile: string | null) {
  const { dir, credentialPath } = await makeTempHome();
  await writeFile(credentialPath, `${JSON.stringify(storedCredential())}\n`);
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const transport = apiKeyTransport();
  const exitCode = await runCli(
    [
      "api-keys",
      "create",
      "--json",
      "--app",
      "app_1",
      "--env",
      "env_1",
      ...(outputFile ? ["--output-file", outputFile] : []),
    ],
    { cwd: dir, credentialPath, fetch: transport.fetch },
  );
  return { dir, exitCode, log, error, transport };
}

/**
 * The raw API Key is surfaced once and never readable again, so a run whose
 * stdout is captured to a log has published a credential permanently.
 */
describe("api-keys create --output-file keeps the secret off both streams", () => {
  it("writes the secret to the file and reports the path instead of the value", async () => {
    const { dir } = await makeTempHome();
    const target = join(dir, "api-key.txt");
    const { exitCode, log, error } = await createKeyInto(target);

    expect(exitCode).toBe(EXIT_OK);
    expect(await readFile(target, "utf8")).toBe(`${SECRET}\n`);
    // 0600, not just "a file": a group-readable credential on a shared box is
    // the same leak by a slower route.
    expect((await stat(target)).mode & 0o777).toBe(0o600);
    const written = [...log.mock.calls, ...error.mock.calls].join(" ");
    expect(written).not.toContain(SECRET);
    expect(JSON.parse(log.mock.calls.join(""))).toMatchObject({
      credential: CREATED_KEY.credential,
      value: null,
      valueWrittenTo: target,
    });
  });

  it("requires --output-file before the Key is minted", async () => {
    const { exitCode, log, error, transport } = await createKeyInto(null);

    expect(exitCode).toBe(EXIT_USAGE);
    expect(log.mock.calls.join("")).not.toContain(SECRET);
    expect(error.mock.calls.join(" ")).toContain("--output-file is required");
    expect(transport.requests).toHaveLength(0);
  });

  it("refuses an existing path before the Key is minted", async () => {
    const { dir } = await makeTempHome();
    const target = join(dir, "taken.txt");
    await writeFile(target, "someone else's secret\n");

    const { exitCode, error } = await createKeyInto(target);

    expect(exitCode).toBe(EXIT_USAGE);
    expect(error.mock.calls.join(" ")).toContain("already exists");
    expect(await readFile(target, "utf8")).toBe("someone else's secret\n");
  });

  it("refuses --output-file on a command that returns no secret", async () => {
    const { dir, credentialPath } = await makeTempHome();
    await writeFile(credentialPath, `${JSON.stringify(storedCredential())}\n`);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    const exitCode = await runCli(
      ["flags", "list", "--app", "app_1", "--output-file", join(dir, "nope.txt")],
      { cwd: dir, credentialPath, fetch: apiKeyTransport().fetch },
    );

    expect(exitCode).toBe(EXIT_USAGE);
    expect(error.mock.calls.join(" ")).toContain("is not accepted by splitch flags list");
  });
});

describe("Sentry once-only secrets", () => {
  it.each([
    {
      args: [
        "sentry-installations",
        "create",
        "--org",
        "org_1",
        "--body-json",
        '{"installationId":"00000000-0000-4000-8000-000000000001","webhookUrl":"https://sentry.example.test/flags"}',
      ],
      path: "/orgs/org_1/integrations/sentry",
      body: {
        installationId: "00000000-0000-4000-8000-000000000001",
        orgId: "org_1",
        webhookUrl: "https://sentry.example.test/flags",
        status: "active",
        webhookSecret: "sentry_secret_do_not_log",
      },
    },
    {
      args: [
        "sentry-secret-rotations",
        "create",
        "--org",
        "org_1",
        "00000000-0000-4000-8000-000000000001",
        "--body-json",
        '{"rotationId":"00000000-0000-4000-8000-000000000002"}',
      ],
      path: "/secret-rotations",
      body: {
        installationId: "00000000-0000-4000-8000-000000000001",
        rotationId: "00000000-0000-4000-8000-000000000002",
        status: "active",
        webhookSecret: "sentry_secret_do_not_log",
      },
    },
  ])("writes $path secrets only to a 0600 file", async ({ args, path, body }) => {
    const { dir, credentialPath } = await makeTempHome();
    await writeFile(credentialPath, `${JSON.stringify(storedCredential())}\n`);
    const target = join(dir, "sentry-secret.txt");
    const transport = new FakeCliTransport([
      ...scopeResolutionStubs(),
      { match: (request) => request.url.includes(path), status: 201, body },
    ]);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    const exitCode = await runCli([...args, "--output-file", target, "--json"], {
      cwd: dir,
      credentialPath,
      fetch: transport.fetch,
    });

    expect(exitCode).toBe(EXIT_OK);
    expect(await readFile(target, "utf8")).toBe("sentry_secret_do_not_log\n");
    expect((await stat(target)).mode & 0o777).toBe(0o600);
    expect([...log.mock.calls, ...error.mock.calls].join(" ")).not.toContain(
      "sentry_secret_do_not_log",
    );
    expect(JSON.parse(log.mock.calls.join(""))).toMatchObject({
      webhookSecret: null,
      webhookSecretWrittenTo: target,
    });
  });

  it("rejects an inline Sentry secret before any request", async () => {
    const { dir, credentialPath } = await makeTempHome();
    await writeFile(credentialPath, `${JSON.stringify(storedCredential())}\n`);
    const transport = new FakeCliTransport([]);
    vi.spyOn(console, "error").mockImplementation(() => {});

    const exitCode = await runCli(
      [
        "sentry-installations",
        "create",
        "--org",
        "org_1",
        "--body-json",
        '{"installationId":"00000000-0000-4000-8000-000000000001","webhookUrl":"https://sentry.example.test/flags","webhookSecret":"do_not_put_secrets_in_argv"}',
        "--output-file",
        join(dir, "secret.txt"),
      ],
      { cwd: dir, credentialPath, fetch: transport.fetch },
    );

    expect(exitCode).toBe(EXIT_USAGE);
    expect(transport.requests).toHaveLength(0);
  });
});
