import { defineConfig } from "vitest/config";
import workersConfig from "./vitest.config.workers";

export default defineConfig(async (configEnv) => {
  const config = await workersConfig(configEnv);
  return {
    ...config,
    test: {
      ...config.test,
      include: ["load-test/integration-delivery.load.ts"],
      testTimeout: 300_000,
      maxWorkers: 1,
      reporters: [
        "default",
        {
          onTestCaseResult(testCase) {
            console.log(
              "integration-delivery-load-result",
              JSON.stringify(testCase.meta().deliveryLoadResult),
            );
          },
        },
      ],
    },
  };
});
