import { afterAll, afterEach, beforeAll, beforeEach, describe, it } from "vitest";
import type { PackedSdk } from "./dark-launch-http.js";
import { runLocalDarkLaunchScenario } from "./dark-launch-scenario.js";
import { makeQuickstartHarness, type QuickstartHarness } from "./quickstart-local-harness.js";
import { cleanupTempHomes } from "./test-helpers.js";

let packedSdk: PackedSdk;
let consumerDispose: (() => void) | undefined;

beforeAll(async () => {
  const { installPackedSdkConsumer } = await import(
    "../../../scripts/dark-launch/pack-consumer.mjs"
  );
  const consumer = installPackedSdkConsumer();
  consumerDispose = () => consumer.dispose();
  packedSdk = (await consumer.importSdk()) as PackedSdk;
}, 300_000);

afterEach(async () => {
  await cleanupTempHomes();
});

afterAll(() => {
  consumerDispose?.();
});

describe("CLI-to-SDK dark-launch integration", () => {
  let harness: QuickstartHarness;

  beforeEach(async () => {
    harness = await makeQuickstartHarness();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it("proves CLI setup → live Run → one packed-SDK Exposure → cleanup", async () => {
    await runLocalDarkLaunchScenario(harness, packedSdk);
  }, 60_000);
});
