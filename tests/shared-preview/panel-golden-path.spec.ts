import { expect, test } from "@playwright/test";
import { createApp, createFlag, createMetric, editFlag, openApp } from "./panel-actions";
import {
  createExperimentDraft,
  expectResultsRendered,
  startRunOne,
} from "./panel-experiment-actions";
import { signInThroughAuthKit } from "./panel-login";
import { readPanelCredentials, readSmokeConfig } from "./smoke-config";

/**
 * The hosted proof that a human can actually use the deployed Control Panel. The API
 * smoke covers the machine surfaces; nothing there would notice a panel that renders a
 * blank shell, refuses login, or drops a write.
 *
 * One test, not seven: the golden path is a single causal chain, and splitting it would
 * either re-run the whole login and setup per step or leak state between tests.
 */
test.describe("shared-preview Control Panel golden path", () => {
  test("signs in through AuthKit and runs an Experiment end to end", async ({ page }) => {
    test.slow();
    const config = readSmokeConfig();

    await signInThroughAuthKit(page, config, readPanelCredentials());

    const appSlug = await createApp(page, config);
    await openApp(page, config, appSlug);

    const flagKey = await createFlag(page, config, appSlug);
    await editFlag(page, config, appSlug, flagKey);

    const metricName = await createMetric(page, config, appSlug);
    await createExperimentDraft(page, config, appSlug, flagKey);
    await startRunOne(page, appSlug, metricName);

    // Start freezes Run 1, so the frozen setup is the read-back that proves it committed.
    expect(page.url(), "Start did not land on the frozen Run setup").toMatch(/\/setup$/);
    await expectResultsRendered(page, appSlug);
  });
});
