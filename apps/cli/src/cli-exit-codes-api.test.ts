import { writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "./cli.js";
import { EXIT_OK } from "./exit-codes.js";
import { scopeResolutionStubs } from "./scope-resolution-fixtures.js";
import {
  authHeader,
  createAppResponse,
  FakeCliTransport,
  flagConfigResponse,
  flagRecord,
  oauthTokenMint,
  promoteResponse,
  startRunResponse,
  storedCredential,
  testEvalResponse,
} from "./test-fixtures.js";
import { cleanupTempHomes, makeTempHome } from "./test-helpers.js";

afterEach(async () => {
  await cleanupTempHomes();
});

describe("api command exit codes", () => {
  it("apps create returns 0 on success", async () => {
    const { credentialPath } = await makeTempHome();
    await writeFile(credentialPath, `${JSON.stringify(storedCredential())}\n`);
    const transport = new FakeCliTransport([
      oauthTokenMint(),
      {
        match: (request) => request.url.includes("/orgs/org_1/apps") && request.method === "POST",
        status: 200,
        body: createAppResponse,
      },
    ]);

    const code = await runCli(["apps", "create", "--json", "--org", "org_1", "--name", "New App"], {
      credentialPath,
      fetch: transport.fetch,
    });
    expect(code).toBe(EXIT_OK);
    // apps_create rebinds to the target Org, so the API call carries the
    // freshly minted org-bound token, not the stored default.
    expect(transport.requests.at(-1)?.authorization).toBe("Bearer refreshed-access-token");
  });

  it("flags create returns 0 on success", async () => {
    const { credentialPath } = await makeTempHome();
    await writeFile(credentialPath, `${JSON.stringify(storedCredential())}\n`);
    const transport = new FakeCliTransport([
      ...scopeResolutionStubs(),
      {
        match: (request) => request.url.includes("/apps/app_1/flags") && request.method === "POST",
        status: 200,
        body: flagRecord,
      },
    ]);

    const code = await runCli(
      ["flags", "create", "--json", "--app", "app_1", "--key", "checkout", "--variants", "on,off"],
      { credentialPath, fetch: transport.fetch },
    );
    expect(code).toBe(EXIT_OK);
  });
});

describe("approval command exit codes", () => {
  const FLAG_1 = [{ id: "flag_1", key: "flag-1", name: "Flag 1" }] as const;

  it("flags promote --confirm returns 0 on success", async () => {
    const { credentialPath } = await makeTempHome();
    await writeFile(credentialPath, `${JSON.stringify(storedCredential())}\n`);
    const transport = new FakeCliTransport([
      ...scopeResolutionStubs({ flags: FLAG_1 }),
      {
        match: (request) => request.url.includes("/promote") && request.method === "POST",
        status: 200,
        body: promoteResponse,
      },
    ]);

    const code = await runCli(
      [
        "flags",
        "promote",
        "--json",
        "--confirm",
        "--app",
        "app_1",
        "--env",
        "env_target",
        "flag_1",
        "--from-environment-id",
        "env_source",
      ],
      { credentialPath, fetch: transport.fetch },
    );
    expect(code).toBe(EXIT_OK);
    const promote = transport.requests.find((request) => request.url.includes("/promote"));
    expect(promote?.body).toMatchObject({
      review: { action: "approve_and_apply" },
      idempotency_key: expect.stringMatching(/^cli_/),
      fromEnvironmentId: "env_source",
    });
  });

  it("flag-config update --confirm returns 0 on success", async () => {
    const { credentialPath } = await makeTempHome();
    await writeFile(credentialPath, `${JSON.stringify(storedCredential())}\n`);
    const transport = new FakeCliTransport([
      ...scopeResolutionStubs({ flags: FLAG_1 }),
      {
        match: (request) => request.url.includes("/config") && request.method === "PATCH",
        status: 200,
        body: { config: flagConfigResponse, approvalRequest: null },
      },
    ]);

    const code = await runCli(
      [
        "flag-config",
        "update",
        "--json",
        "--confirm",
        "--app",
        "app_1",
        "--env",
        "env_1",
        "flag_1",
        "--enabled",
        "true",
      ],
      { credentialPath, fetch: transport.fetch },
    );
    expect(code).toBe(EXIT_OK);
    const patch = transport.requests.find((request) => request.method === "PATCH");
    expect(patch?.body).toMatchObject({
      review: { action: "approve_and_apply" },
      idempotency_key: expect.stringMatching(/^cli_/),
      enabled: true,
    });
  });

  it("experiments start --confirm returns 0 on success", async () => {
    const { credentialPath } = await makeTempHome();
    await writeFile(credentialPath, `${JSON.stringify(storedCredential())}\n`);
    const transport = new FakeCliTransport([
      ...scopeResolutionStubs(),
      {
        match: (request) => request.url.includes("/start") && request.method === "POST",
        status: 200,
        body: startRunResponse,
      },
    ]);

    const code = await runCli(
      ["experiments", "start", "--json", "--confirm", "--app", "app_1", "--env", "env_1", "exp_1"],
      { credentialPath, fetch: transport.fetch },
    );
    expect(code).toBe(EXIT_OK);
    const start = transport.requests.find((request) => request.url.includes("/start"));
    expect(start?.body).toMatchObject({
      review: { action: "approve_and_apply" },
      idempotency_key: expect.stringMatching(/^cli_/),
    });
  });
});

describe("remaining API command exit codes", () => {
  it("flags test-eval returns 0 on success", async () => {
    const { credentialPath } = await makeTempHome();
    await writeFile(credentialPath, `${JSON.stringify(storedCredential())}\n`);
    const transport = new FakeCliTransport([
      ...scopeResolutionStubs(),
      {
        match: (request) => request.url.includes("/test-eval") && request.method === "POST",
        status: 200,
        body: testEvalResponse,
      },
    ]);

    const code = await runCli(
      [
        "flags",
        "test-eval",
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
    const call = transport.requests.find((request) => request.url.includes("/test-eval"));
    expect(call?.authorization).toBe(authHeader());
  });
});
