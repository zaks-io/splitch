import { defineConfig } from "vitest/config";
import unit from "./vitest.config.unit";

// Invoked by tinybird:local while its real Tinybird service is alive.
export default defineConfig({
  ...unit,
  test: {
    ...unit.test,
    name: "audit-integration",
    include: ["test/audit-tinybird.integration.ts"],
    exclude: [],
    maxWorkers: 2,
  },
});
