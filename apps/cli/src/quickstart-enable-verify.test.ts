import { writeFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCli } from "./cli.js";
import { EXIT_OK } from "./exit-codes.js";
import {
  makeQuickstartHarness,
  type QuickstartHarness,
  quickstartOrigins,
  storedHarnessCredential,
} from "./quickstart-local-harness.js";
import { cleanupTempHomes, makeTempHome } from "./test-helpers.js";

const quickstartCreateArgs = [
  "flags",
  "create",
  "--json",
  "--key",
  "new-checkout",
  "--variants",
  "on,off",
] as const;

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupTempHomes();
});

// Real CLI-to-control-plane lifecycle against the harness; keep the timeout
// elevated for contended CI runners (same rationale as quickstart-drift).
describe("quickstart enable+rollout verify (SPL-324)", { timeout: 60_000 }, () => {
  let harness: QuickstartHarness;

  beforeEach(async () => {
    harness = await makeQuickstartHarness();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it("executes the documented enable+rollout 100 path to a SPLIT verify", async () => {
    const { credentialPath } = await makeTempHome();
    await writeFile(credentialPath, `${JSON.stringify(storedHarnessCredential(harness))}\n`);
    const cliOptions = {
      credentialPath,
      fetch: harness.routingFetch,
      controlPlaneBaseUrl: quickstartOrigins.controlPlaneBaseUrl,
      evaluationBaseUrl: quickstartOrigins.evaluationBaseUrl,
    };
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    const createCode = await runCli([...quickstartCreateArgs, "--app", harness.appId], cliOptions);
    expect(createCode).toBe(EXIT_OK);

    const beforeVerify = await runCli(
      [
        "flags",
        "verify",
        "--json",
        "--app",
        harness.appId,
        "--env",
        harness.devEnvironmentId,
        "new-checkout",
        "--targeting-key",
        "test-user-1",
      ],
      cliOptions,
    );
    expect(beforeVerify).toBe(EXIT_OK);
    const beforeBody = JSON.parse(String(log.mock.calls.at(-1)?.[0]));
    expect(beforeBody).toMatchObject({
      value: false,
      variantName: "off",
      reason: "DISABLED",
    });

    const configureCode = await runCli(
      [
        "flag-config",
        "update",
        "--json",
        "--app",
        harness.appId,
        "--env",
        harness.devEnvironmentId,
        "new-checkout",
        "--enabled",
        "true",
        "--rollout",
        "100",
      ],
      cliOptions,
    );
    expect(configureCode).toBe(EXIT_OK);

    // The harness Provider caches Flag Configuration; production invalidates via
    // live updates. Drop the cache so the post-enable verify reads the write.
    harness.invalidateFlagCache();

    const afterVerify = await runCli(
      [
        "flags",
        "verify",
        "--json",
        "--app",
        harness.appId,
        "--env",
        harness.devEnvironmentId,
        "new-checkout",
        "--targeting-key",
        "test-user-1",
      ],
      cliOptions,
    );
    expect(afterVerify).toBe(EXIT_OK);
    const afterBody = JSON.parse(String(log.mock.calls.at(-1)?.[0]));
    expect(afterBody).toMatchObject({
      value: true,
      variantName: "on",
      reason: "SPLIT",
    });
  });
});
