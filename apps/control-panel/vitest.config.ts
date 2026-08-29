import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: [
      sourceAlias("@splitch/contracts/route-types", "../../packages/contracts/src/route-types.ts"),
      sourceAlias("@splitch/contracts", "../../packages/contracts/src/index.ts"),
      sourceSubpathAlias("control-plane-sdk"),
      sourceAlias("@splitch/control-plane-sdk", "../../packages/control-plane-sdk/src/index.ts"),
      sourceAlias("@splitch/db/test-d1", "../../packages/db/src/repo/test-d1.ts"),
      sourceAlias("@splitch/db", "../../packages/db/src/index.ts"),
      sourceSubpathAlias("observability"),
      sourceAlias("@splitch/sdk", "../../packages/sdk/src/index.ts"),
      sourceSubpathAlias("ui", ""),
      sourceAlias("@splitch/worker-runtime", "../../packages/worker-runtime/src/index.ts"),
    ],
  },
  test: {
    environment: "node",
    passWithNoTests: true,
    // 15s, matching every other workspace config. The surface-discovery suites
    // build a real TypeScript `Program` per case, which runs ~250ms locally and
    // ~2s on a loaded CI runner, so the 5s default left no margin and timed one
    // case out under load.
    testTimeout: 15_000,
  },
});

function sourceAlias(find: string, path: string) {
  return { find, replacement: fileURLToPath(new URL(path, import.meta.url)) };
}

function sourceSubpathAlias(packageName: string, extension = ".ts") {
  return {
    find: new RegExp(`^@splitch/${packageName}/(.+)$`),
    replacement: fileURLToPath(
      new URL(`../../packages/${packageName}/src/$1${extension}`, import.meta.url),
    ),
  };
}
