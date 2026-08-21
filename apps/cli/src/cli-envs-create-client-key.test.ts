import { writeFile } from "node:fs/promises";
import { getRoute } from "@splitch/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli } from "./cli.js";
import { EXIT_OK } from "./exit-codes.js";
import { scopeResolutionStubs } from "./scope-resolution-fixtures.js";
import { FakeCliTransport, storedCredential } from "./test-fixtures.js";
import { cleanupTempHomes, makeTempHome } from "./test-helpers.js";

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupTempHomes();
});

const timestamp = "2026-07-03T00:00:00.000Z";

// The Environment plus the Client Key auto-provisioned with it, as the Worker
// answers `environments_create` (SPL-377). Parsed by the route contract below so
// this stub cannot drift into a shape the CLI would never receive.
const createEnvironmentResponse = {
  id: "env_qa",
  appId: "app_1",
  key: "qa",
  name: "QA",
  policy: {
    variantAvailability: "allow",
    targetingRolloutValue: "allow",
    enabledState: "allow",
    startExperimentRun: "allow",
  },
  createdAt: timestamp,
  updatedAt: timestamp,
  clientKey: {
    keyId: "ck_qa",
    appId: "app_1",
    environmentId: "env_qa",
    keyMaterial: "pk_qa_client_key",
    originAllowlist: null,
    isOriginOpen: true,
    rateLimitRps: null,
    revokedAt: null,
    createdAt: timestamp,
  },
};

const createArgs = ["envs", "create", "--app", "app_1", "--key", "qa", "--name", "QA"] as const;

function envsCreateTransport(): FakeCliTransport {
  return new FakeCliTransport([
    ...scopeResolutionStubs(),
    {
      match: (request) => request.url.endsWith("/envs") && request.method === "POST",
      status: 200,
      body: createEnvironmentResponse,
    },
  ]);
}

describe("splitch envs create surfaces the auto-provisioned Client Key", () => {
  it("stubs a response the environments_create contract accepts", () => {
    const output = getRoute("environments_create")?.output;
    expect(output).toBeDefined();
    expect(output?.parse(createEnvironmentResponse)).toMatchObject({
      id: "env_qa",
      clientKey: { keyMaterial: "pk_qa_client_key" },
    });
  });

  it("carries the Client Key on --json stdout", async () => {
    const { dir, credentialPath } = await makeTempHome();
    await writeFile(credentialPath, `${JSON.stringify(storedCredential())}\n`);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    const code = await runCli([...createArgs, "--json"], {
      credentialPath,
      cwd: dir,
      fetch: envsCreateTransport().fetch,
      env: {},
    });

    expect(code).toBe(EXIT_OK);
    const payload = JSON.parse(log.mock.calls.join("")) as {
      id: string;
      clientKey: { keyId: string; keyMaterial: string; isOriginOpen: boolean };
    };
    expect(payload.id).toBe("env_qa");
    expect(payload.clientKey).toMatchObject({
      keyId: "ck_qa",
      keyMaterial: "pk_qa_client_key",
      isOriginOpen: true,
    });
  });

  it("names the Client Key in human output and leaks no API Key material", async () => {
    const { dir, credentialPath } = await makeTempHome();
    await writeFile(credentialPath, `${JSON.stringify(storedCredential())}\n`);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    const code = await runCli([...createArgs], {
      credentialPath,
      cwd: dir,
      fetch: envsCreateTransport().fetch,
      env: {},
    });

    expect(code).toBe(EXIT_OK);
    const output = log.mock.calls.flat().join("\n");
    expect(output).toContain("clientKey");
    expect(output).toContain("pk_qa_client_key");
    expect(output).not.toContain("sk_");
    expect(output).not.toContain("scopes");
  });
});
