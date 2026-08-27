import { writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "./cli.js";
import { EXIT_API, EXIT_OK } from "./exit-codes.js";
import { flagsListStub, scopeResolutionStubs } from "./scope-resolution-fixtures.js";
import { FakeCliTransport, flagConfigResponse, storedCredential } from "./test-fixtures.js";
import { cleanupTempHomes, makeTempHome } from "./test-helpers.js";

afterEach(async () => {
  await cleanupTempHomes();
});

describe("flag-targeting-rules replace body stripping (SPL-296)", () => {
  it("omits CLI-injected context ids from an invalid --body-json request body", async () => {
    const { credentialPath } = await makeTempHome();
    await writeFile(credentialPath, `${JSON.stringify(storedCredential())}\n`);
    const transport = new FakeCliTransport([
      ...scopeResolutionStubs(),
      flagsListStub({ flags: [{ id: "flag_1", key: "flag-1", name: "Flag 1" }] }),
      {
        match: (request) => request.method === "PUT" && request.url.includes("/targeting-rules"),
        status: 400,
        body: {
          code: "VALIDATION_ERROR",
          message: "request failed schema validation",
          details: {
            issues: [{ path: ["body"], message: 'Unrecognized keys: "rules"' }],
          },
        },
      },
    ]);

    const code = await runCli(
      [
        "flag-targeting-rules",
        "replace",
        "--json",
        "--app",
        "app_1",
        "--env",
        "env_1",
        "flag_1",
        "--body-json",
        JSON.stringify({ rules: [] }),
      ],
      { credentialPath, fetch: transport.fetch },
    );

    expect(code).toBe(EXIT_API);
    const replace = transport.requests.find(
      (request) => request.method === "PUT" && request.url.includes("/targeting-rules"),
    );
    expect(replace?.url).toContain("/apps/app_1/envs/env_1/flags/flag_1/targeting-rules");
    expect(replace?.body).toEqual({
      rules: [],
      idempotency_key: expect.any(String),
    });
    expect(replace?.body).not.toHaveProperty("appId");
    expect(replace?.body).not.toHaveProperty("environmentId");
    expect(replace?.body).not.toHaveProperty("flagId");
  });

  it("still strips path context on a successful targeting-rules replace", async () => {
    const { credentialPath } = await makeTempHome();
    await writeFile(credentialPath, `${JSON.stringify(storedCredential())}\n`);
    const transport = new FakeCliTransport([
      ...scopeResolutionStubs(),
      flagsListStub({ flags: [{ id: "flag_1", key: "flag-1", name: "Flag 1" }] }),
      {
        match: (request) => request.method === "PUT" && request.url.includes("/targeting-rules"),
        status: 200,
        body: { ...flagConfigResponse, approvalRequest: null },
      },
    ]);

    const code = await runCli(
      [
        "flag-targeting-rules",
        "replace",
        "--json",
        "--app",
        "app_1",
        "--env",
        "env_1",
        "flag_1",
        "--body-json",
        JSON.stringify({ targetingRules: [] }),
      ],
      { credentialPath, fetch: transport.fetch },
    );

    expect(code).toBe(EXIT_OK);
    const replace = transport.requests.find(
      (request) => request.method === "PUT" && request.url.includes("/targeting-rules"),
    );
    expect(replace?.body).toEqual({
      targetingRules: [],
      idempotency_key: expect.any(String),
    });
  });
});
