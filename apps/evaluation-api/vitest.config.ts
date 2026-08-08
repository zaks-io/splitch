import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";

const sharedAlias = {
  "@splitch/contracts": fileURLToPath(
    new URL("../../packages/contracts/src/index.ts", import.meta.url),
  ),
  "@splitch/privacy": fileURLToPath(
    new URL("../../packages/privacy/src/index.ts", import.meta.url),
  ),
  "@splitch/worker-runtime": fileURLToPath(
    new URL("../../packages/worker-runtime/src/index.ts", import.meta.url),
  ),
};

/**
 * `cloudflare:workers` is stubbed only for the request-binding test that imports
 * `index.ts`. Other suites must not resolve Durable Object / WorkerEntrypoint
 * modules against a plain-class stub.
 */
export default defineConfig({
  test: {
    passWithNoTests: true,
    projects: [
      {
        resolve: {
          alias: {
            ...sharedAlias,
            "cloudflare:workers": fileURLToPath(
              new URL("./test-stubs/cloudflare-workers.ts", import.meta.url),
            ),
          },
        },
        test: {
          name: "request-binding",
          include: ["src/index-request-binding.test.ts"],
        },
      },
      {
        resolve: { alias: sharedAlias },
        test: {
          name: "unit",
          include: ["src/**/*.{test,spec}.ts"],
          exclude: [...configDefaults.exclude, "src/index-request-binding.test.ts"],
        },
      },
    ],
  },
});
