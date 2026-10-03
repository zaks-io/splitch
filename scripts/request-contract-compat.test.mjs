import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
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

test("snapshots real zod contracts: defaults optional, strict closed, stripping open", async () => {
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
    meta: z.object({ note: z.string() }),
  }).strict() }),
}];
`,
    );
    const snapshot = await loadRequestContractSnapshot({ repoRoot, srcDir });
    const body = snapshot.things_create.input.properties.body;
    assert.equal(snapshot.things_create.idempotency, "required");
    assert.deepEqual(body.required, ["name", "meta"]);
    assert.equal(body.additionalProperties, false);
    assert.deepEqual(body.properties.kind.enum, ["ops", "release"]);
    assert.equal("additionalProperties" in body.properties.meta, false);
  } finally {
    rmSync(srcDir, { recursive: true, force: true });
  }
});
