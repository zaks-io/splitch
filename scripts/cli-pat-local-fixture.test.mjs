import assert from "node:assert/strict";
import childProcess from "node:child_process";
import crypto from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createLocalPatFixture } from "./cli-pat-local-fixture.mjs";

// Fault injection stays at Node's filesystem/process/crypto boundaries, without
// starting Wrangler or modifying the managed port registry.
test("failed standalone preparation removes its allocated private directory", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "local-pat-preparation-"));
  const { SBX_AGENT_ID: previousAgent } = process.env;
  process.env.SBX_AGENT_ID = "local-pat-preparation-test";
  const spawn = context.mock.method(childProcess, "spawnSync", () => ({
    status: 0,
    stdout: JSON.stringify({
      state_dir: root,
      ports: {
        "temporary-env-gateway": 0,
        "temporary-env-inspector": 0,
        "temporary-env-issuer": 0,
      },
    }),
  }));
  const key = context.mock.method(crypto, "generateKeyPairSync", () => {
    throw new Error("injected fixture preparation failure");
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(
      createLocalPatFixture(new AbortController().signal, { full: true }),
      /injected fixture preparation failure/,
    );
    assert.deepEqual(
      await readdir(root),
      [],
      "the private directory must be removed before rejection",
    );
  } finally {
    spawn.mock.restore();
    key.mock.restore();
    syncBuiltinESMExports();
    if (previousAgent === undefined) Reflect.deleteProperty(process.env, "SBX_AGENT_ID");
    else process.env.SBX_AGENT_ID = previousAgent;
    await rm(root, { recursive: true, force: true });
  }
});
