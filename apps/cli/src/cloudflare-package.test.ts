import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  installFakeCloudflarePackage,
  installFakeWrangler,
  RecordingRunner,
  setupCloudflare,
} from "./cloudflare-test-fixtures";
import { executeInvocation } from "./execute";
import { parseInvocation } from "./parse-args";

describe("cloudflare package detection", () => {
  it.each([
    ["absent", "ERR_MODULE_NOT_FOUND", async (_cwd: string) => {}],
    [
      "missing its manifest",
      "ENOENT",
      (cwd: string) =>
        mkdir(join(cwd, "node_modules", "@splitch", "cloudflare"), { recursive: true }),
    ],
  ])("fails loudly when @splitch/cloudflare is %s", async (_label, causeCode, prepare) => {
    const cwd = await mkdtemp(join(tmpdir(), "splitch-cloudflare-cli-no-package-"));
    await prepare(cwd);
    await writeFile(join(cwd, "wrangler.jsonc"), JSON.stringify({ name: "customer-app" }));

    const failure = executeInvocation(
      parseInvocation(["cloudflare", "setup", "--env", "production"]),
      {
        cwd,
        env: { SPLITCH_API_KEY: "api-key" },
        commandRunner: new RecordingRunner(),
        io: { log: () => {}, error: () => {} },
      },
    );

    await expect(failure).rejects.toThrow(/@splitch\/cloudflare is not installed in this App/);
    await expect(failure).rejects.toHaveProperty("cause.code", causeCode);
  });

  it("finds @splitch/cloudflare hoisted into a parent workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "splitch-cloudflare-cli-hoisted-"));
    await installFakeCloudflarePackage(root);
    const cwd = join(root, "apps", "api");
    await mkdir(cwd, { recursive: true });
    await installFakeWrangler(cwd);
    await writeFile(join(cwd, "wrangler.jsonc"), JSON.stringify({ name: "customer-app" }));

    const result = await setupCloudflare(cwd, new RecordingRunner(), ["--env", "production"]);

    expect(result.exitCode).toBe(0);
  });
});
