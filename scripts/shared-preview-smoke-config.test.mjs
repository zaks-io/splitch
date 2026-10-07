import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("smoke discovery expects configured AuthKit independently of the Auth API origin", () => {
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { readSmokeConfig } from './tests/shared-preview/smoke-config.ts';
       const config = readSmokeConfig();
       console.log(JSON.stringify({ issuer: config.mcpAuthorizationServer, auth: config.authBaseUrl }));`,
    ],
    {
      cwd: new URL("..", import.meta.url),
      encoding: "utf8",
      env: {
        ...process.env,
        SPLITCH_SMOKE_COMMIT_SHA: "a".repeat(40),
        SPLITCH_SMOKE_AUTH_BASE_URL: "https://auth.preview.splitch.dev",
      },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    issuer: "https://soulful-path-50.authkit.app",
    auth: "https://auth.preview.splitch.dev",
  });
});
