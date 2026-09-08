import { writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli } from "./cli.js";
import { EXIT_API } from "./exit-codes.js";
import { scopeResolutionStubs } from "./scope-resolution-fixtures.js";
import { FakeCliTransport, jsonError, storedCredential } from "./test-fixtures.js";
import { cleanupTempHomes, makeTempHome } from "./test-helpers.js";

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupTempHomes();
});

describe("Experiment conclusion CLI transport", () => {
  it("sends runs conclude with strict camel-case evidence and idempotency fields", async () => {
    const transport = conclusionTransport("/runs/run_1/conclusions");
    const code = await runWithCredential(
      [
        "runs",
        "conclude",
        "exp_1",
        "run_1",
        "--app",
        "app_1",
        "--env",
        "env_1",
        "--confirm",
        "--idempotency-key",
        "conclude-run-1",
        "--body-json",
        JSON.stringify({
          selectedVariant: "treatment",
          expectedResultToken: `sha256:${"a".repeat(64)}`,
          dataWatermark: "2026-09-08T12:00:00.000Z",
          target: {
            environmentId: "env_target",
            flagId: "flag_1",
            expectedConfigVersion: 4,
            proposedConfig: {
              enabled: true,
              availableVariantNames: ["control", "treatment"],
              targetingRules: [],
              rollout: { percentage: 100 },
            },
          },
        }),
      ],
      transport,
    );

    expect(code).toBe(EXIT_API);
    const request = transport.requests.find((candidate) =>
      new URL(candidate.url).pathname.endsWith("/runs/run_1/conclusions"),
    );
    expect(request?.body).toMatchObject({
      idempotencyKey: "conclude-run-1",
      review: { action: "approve_and_apply" },
      selectedVariant: "treatment",
    });
    expect(request?.body).not.toHaveProperty("idempotency_key");
  });

  it("sends stale Promotion replacement to its full conclusion path", async () => {
    const suffix = "/runs/run_1/conclusions/conclusion_1/promotion-requests";
    const transport = conclusionTransport(suffix);
    const code = await runWithCredential(
      [
        "conclusion-promotion-requests",
        "create",
        "exp_1",
        "run_1",
        "conclusion_1",
        "--app",
        "app_1",
        "--env",
        "env_1",
        "--confirm",
        "--idempotency-key",
        "replace-promotion-1",
        "--body-json",
        JSON.stringify({ expectedConfigVersion: 5 }),
      ],
      transport,
    );

    expect(code).toBe(EXIT_API);
    const request = transport.requests.find((candidate) =>
      new URL(candidate.url).pathname.endsWith(suffix),
    );
    expect(request?.body).toEqual({
      expectedConfigVersion: 5,
      review: { action: "approve_and_apply" },
      idempotencyKey: "replace-promotion-1",
    });
  });
});

function conclusionTransport(pathSuffix: string): FakeCliTransport {
  return new FakeCliTransport([
    ...scopeResolutionStubs(),
    {
      match: (request) =>
        request.method === "POST" && new URL(request.url).pathname.endsWith(pathSuffix),
      status: 404,
      body: jsonError("RUN_NOT_FOUND", "Run not found"),
    },
  ]);
}

async function runWithCredential(args: string[], transport: FakeCliTransport): Promise<number> {
  const { credentialPath } = await makeTempHome();
  await writeFile(credentialPath, `${JSON.stringify(storedCredential())}\n`);
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  return runCli(args, { credentialPath, fetch: transport.fetch });
}
