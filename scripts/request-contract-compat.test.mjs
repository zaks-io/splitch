import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { latestCliTag } from "./check-request-contract-compat.mjs";
import { applyAllowlist } from "./lib/request-contract-allowlist.mjs";
import { loadRequestContractSnapshot } from "./lib/request-contract-snapshot.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

test("allowlist excuses current-tag violations, fails stale or malformed entries, and expires old tags", () => {
  const violations = [
    { operationId: "a_create", path: "body.x", rule: "required-added", message: "" },
    { operationId: "b_create", path: "body.y", rule: "field-removed", message: "" },
  ];
  const entry = (operationId, path, releasedTag, reason = "never sent by a released client") => ({
    operationId,
    path,
    releasedTag,
    reason,
  });
  const result = applyAllowlist(
    violations,
    [
      entry("a_create", "body.x", "cli-v1.0.0"),
      entry("b_create", "body.y", "cli-v0.9.0"),
      entry("c_create", "body.z", "cli-v1.0.0"),
      entry("d_create", "body.w", "cli-v1.0.0", " "),
    ],
    "cli-v1.0.0",
  );
  const ids = (items) => items.map((item) => item.operationId);
  assert.deepEqual(ids(result.failing), ["b_create"]);
  assert.deepEqual(ids(result.excused), ["a_create"]);
  assert.deepEqual(ids(result.stale), ["c_create", "d_create"]);
  assert.deepEqual(ids(result.expired), ["b_create"]);
  assert.deepEqual(result.problems, ['entry 3 needs a non-empty string "reason"']);
  assert.deepEqual(applyAllowlist([], {}, "cli-v1.0.0").problems, [
    "allowlist must be a JSON array",
  ]);
});

test("picks the highest semver cli tag, with releases above their prereleases", () => {
  assert.equal(
    latestCliTag(["cli-v0.7.5", "cli-v0.10.0-rc.2", "cli-v0.9.9", "sdk-v9.0.0"]),
    "cli-v0.10.0-rc.2",
  );
  assert.equal(latestCliTag(["cli-v0.10.0-rc.2", "cli-v0.10.0"]), "cli-v0.10.0");
  assert.equal(latestCliTag(["cli-v1.0.0-rc+build+x", "cli-v0.9.0"]), "cli-v1.0.0-rc+build+x");
  assert.equal(latestCliTag(["sdk-v1.0.0"]), undefined);
});

test("fails loud on a cli tag it cannot order instead of skipping it", () => {
  assert.throws(() => latestCliTag(["cli-v0.7.5", "cli-vbad"]), /cli-vbad is not a release semver/);
});

test("snapshots real zod contracts with defaulted fields optional and strict objects closed", async () => {
  const srcDir = mkdtempSync(join(tmpdir(), "request-contract-fixture-"));
  try {
    writeFileSync(
      join(srcDir, "route-registry.ts"),
      `import { z } from "zod";
export const routeRegistry = [{
  operationId: "things_create",
  method: "POST",
  path: "/v1/things",
  idempotency: "required",
  input: z.object({ body: z.object({
    name: z.string(),
    kind: z.enum(["ops", "release"]).default("release"),
  }).strict() }),
}];
`,
    );
    const snapshot = await loadRequestContractSnapshot({ repoRoot, srcDir });
    const body = snapshot.things_create.input.properties.body;
    assert.equal(snapshot.things_create.idempotency, "required");
    assert.deepEqual(body.required, ["name"]);
    assert.equal(body.additionalProperties, false);
    assert.deepEqual(body.properties.kind.enum, ["ops", "release"]);
  } finally {
    rmSync(srcDir, { recursive: true, force: true });
  }
});
