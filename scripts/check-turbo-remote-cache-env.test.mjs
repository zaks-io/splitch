import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = fileURLToPath(new URL("./check-turbo-remote-cache-env.mjs", import.meta.url));

test("warns without blocking optional remote caching", () => {
  const result = runCheck([]);

  assert.equal(result.status, 0);
  assert.match(result.stdout, /::warning title=Turbo remote cache unavailable::/);
  assert.doesNotMatch(result.stdout, /secret-value/);
});

test("fails loud when required remote cache inputs are missing", () => {
  const result = runCheck(["--required"]);

  assert.equal(result.status, 1);
  assert.match(result.stdout, /::error title=Turbo remote cache unavailable::/);
});

test("accepts a cryptographically strong signature key", () => {
  const result = runCheck(["--required"], {
    TURBO_TOKEN: "token",
    TURBO_TEAM: "team",
    TURBO_REMOTE_CACHE_SIGNATURE_KEY: "x".repeat(32),
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Turbo remote cache inputs are present/);
  assert.doesNotMatch(result.stdout, /x{32}/);
});

function runCheck(args, env = {}) {
  return spawnSync(process.execPath, [script, ...args], {
    encoding: "utf8",
    env,
  });
}
