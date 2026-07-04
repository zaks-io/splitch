import { test } from "./fixtures";

test.describe("shared-preview health", () => {
  test("every deployed surface reports the shared-preview target", async ({
    smokeConfig,
    smoke,
  }) => {
    for (const route of smokeConfig.healthRoutes) {
      await test.step(route.surface, async () => {
        await smoke.assertHealth(route);
      });
    }
  });
});
