import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { requireSafeOutput } from "./cli-pat-local-fixture.mjs";
import { apiWorkers, createApiFleetConfigs, localE2eWorkers } from "./local-e2e-fleet-config.mjs";

test("standalone API configurations isolate service names, credentials and origins without changing the panel fleet", async (context) => {
  const roots = await Promise.all(
    ["first", "second"].map((name) => mkdtemp(join(tmpdir(), `local-e2e-${name}-`))),
  );
  context.after(() => Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))));
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  for (const [index, root] of roots.entries()) {
    const agent = `isolated-${index}`;
    const origin = `http://127.0.0.1:${12030 + index}`;
    const configs = await createApiFleetConfigs({
      root,
      agent,
      origin,
      issuerOrigin: "http://127.0.0.1:12032",
      privateKey,
    });
    assert.equal(configs.length, 7);
    const gateway = JSON.parse(await readFile(configs[0], "utf8"));
    assert.equal(gateway.services.length, 6);
    const workers = await Promise.all(
      configs.slice(1).map(async (path) => JSON.parse(await readFile(path, "utf8"))),
    );
    assert.deepEqual(
      workers.map((worker) => worker.name),
      apiWorkers.map((worker) => `splitch-${worker}-${agent}`),
    );
    for (const worker of workers) {
      assert.equal(worker.vars.CONTROL_PLANE_ORIGIN, origin);
      assert.equal(worker.vars.AUTH_API_ORIGIN, `http://localhost:${12030 + index}`);
      assert.equal(worker.secrets, undefined);
      assert.equal(worker.env, undefined);
      assert.ok((worker.services ?? []).every((binding) => binding.service.endsWith(`-${agent}`)));
      for (const binding of worker.kv_namespaces ?? []) assert.ok(binding.id.startsWith("local-"));
    }
  }
  assert.deepEqual(
    localE2eWorkers("unchanged", { full: true }).map((worker) => worker.name),
    ["analysis-source", "control-panel"],
  );
});

test("diagnostic output rejects key and token material without echoing it", () => {
  for (const prefix of ["spl_pat_", "sk_", "pk_"]) {
    assert.throws(
      () => requireSafeOutput(`${prefix}${"f".repeat(64)}`),
      /captured output was suppressed/,
    );
  }
  requireSafeOutput("PASS private material remained captured");
});
