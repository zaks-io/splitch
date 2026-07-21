import { writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "./cli.js";
import { EXIT_OK } from "./exit-codes.js";
import {
  authHeader,
  createAppResponse,
  flagConfigResponse,
  flagRecord,
  FakeCliTransport,
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
    expect(transport.requests[0]?.authorization).toBe(authHeader());
  });

  it("flags create returns 0 on success", async () => {
    const { credentialPath } = await makeTempHome();
    await writeFile(credentialPath, `${JSON.stringify(storedCredential())}\n`);
    const transport = new FakeCliTransport([
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

  it("flags promote --confirm returns 0 on success", async () => {
    const { credentialPath } = await makeTempHome();
    await writeFile(credentialPath, `${JSON.stringify(storedCredential())}\n`);
    const transport = new FakeCliTransport([
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
    expect(promote?.body).toMatchObject({ confirm: true, fromEnvironmentId: "env_source" });
  });

  it("flag-config update --confirm returns 0 on success", async () => {
    const { credentialPath } = await makeTempHome();
    await writeFile(credentialPath, `${JSON.stringify(storedCredential())}\n`);
    const transport = new FakeCliTransport([
      {
        match: (request) => request.url.includes("/config") && request.method === "PATCH",
        status: 200,
        body: flagConfigResponse,
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
    expect(patch?.body).toMatchObject({ confirm: true, enabled: true });
  });

  it("experiments start --confirm returns 0 on success", async () => {
    const { credentialPath } = await makeTempHome();
    await writeFile(credentialPath, `${JSON.stringify(storedCredential())}\n`);
    const transport = new FakeCliTransport([
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
    expect(start?.body).toMatchObject({ confirm: true });
  });

  it("flags test-eval returns 0 on success", async () => {
    const { credentialPath } = await makeTempHome();
    await writeFile(credentialPath, `${JSON.stringify(storedCredential())}\n`);
    const transport = new FakeCliTransport([
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
