import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { latestCliTag } from "./check-request-contract-compat.mjs";
import { applyAllowlist, diffRequestContracts } from "./lib/request-contract-diff.mjs";
import { loadRequestContractSnapshot } from "./lib/request-contract-snapshot.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

const str = { type: "string" };
const strict = (properties, required = []) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
const route = (body, extra = {}) => ({
  method: "POST",
  path: "/v1/things",
  input: { type: "object", properties: { body } },
  ...extra,
});
const diffBodies = (before, after) =>
  diffRequestContracts({ things_create: route(before) }, { things_create: route(after) }).map(
    ({ path, rule }) => `${path} ${rule}`,
  );

test("flags a field that became required, whether it was absent or optional", () => {
  const before = strict({ name: str, note: str }, ["name"]);
  const after = strict({ name: str, note: str, kind: str }, ["name", "note", "kind"]);
  assert.deepEqual(diffBodies(before, after), [
    "body.note required-added",
    "body.kind required-added",
  ]);
});

test("accepts a new optional field and a required field that became optional", () => {
  const before = strict({ name: str }, ["name"]);
  const after = strict({ name: str, kind: str }, []);
  assert.deepEqual(diffBodies(before, after), []);
});

test("flags a removed field only when HEAD rejects unknown keys", () => {
  const before = strict({ name: str, legacy: str }, ["name"]);
  assert.deepEqual(diffBodies(before, strict({ name: str }, ["name"])), [
    "body.legacy field-removed",
  ]);
  const stripping = { type: "object", properties: { name: str }, required: ["name"] };
  assert.deepEqual(diffBodies(before, stripping), []);
});

test("flags enum and literal values HEAD no longer accepts", () => {
  const before = strict({
    kind: { type: "string", enum: ["ops", "release", "experiment"] },
    mode: { type: "string", const: "fast" },
  });
  const after = strict({
    kind: { type: "string", enum: ["ops", "release", "permission"] },
    mode: { type: "string", const: "slow" },
  });
  assert.deepEqual(diffBodies(before, after), [
    "body.kind literal-removed",
    "body.mode literal-removed",
  ]);
  const widened = strict({ kind: str, mode: str });
  assert.deepEqual(diffBodies(before, widened), []);
});

test("recurses through arrays of objects, records, and nullable wrappers", () => {
  const variant = (properties, required) => ({
    type: "array",
    items: strict(properties, required),
  });
  const before = strict({
    variants: variant({ name: str }, ["name"]),
    labels: { type: "object", additionalProperties: strict({ color: str }) },
    owner: { anyOf: [strict({ id: str }, ["id"]), { type: "null" }] },
  });
  const after = strict({
    variants: variant({ name: str, weight: { type: "number" } }, ["name", "weight"]),
    labels: { type: "object", additionalProperties: strict({ color: str }, ["color"]) },
    owner: strict({ id: str, team: str }, ["id", "team"]),
  });
  assert.deepEqual(diffBodies(before, after), [
    "body.variants[].weight required-added",
    "body.labels.*.color required-added",
    "body.owner type-narrowed",
    "body.owner.team required-added",
  ]);
});

test("pairs discriminated union variants by their const tag", () => {
  const rule = (type, properties, required) =>
    strict({ type: { type: "string", const: type }, ...properties }, ["type", ...required]);
  const before = {
    oneOf: [rule("segment", { segmentId: str }, ["segmentId"]), rule("everyone", {}, [])],
  };
  const after = {
    oneOf: [rule("segment", { segmentId: str, op: str }, ["segmentId", "op"])],
  };
  assert.deepEqual(diffBodies(before, after), [
    "body.op required-added",
    "body.type variant-removed",
  ]);
});

test("flags narrowed primitive unions but treats integer as a number", () => {
  const before = strict({ value: { anyOf: [str, { type: "integer" }, { type: "boolean" }] } });
  const after = strict({ value: { anyOf: [{ type: "string", enum: ["a"] }, { type: "number" }] } });
  assert.deepEqual(diffBodies(before, after), [
    "body.value type-narrowed",
    "body.value type-narrowed",
  ]);
});

test("flags removed and moved routes", () => {
  const released = { a_get: route(str), b_get: route(str) };
  const head = { b_get: route(str, { path: "/v2/things" }) };
  assert.deepEqual(
    diffRequestContracts(released, head).map(({ operationId, rule }) => `${operationId} ${rule}`),
    ["a_get route-removed", "b_get route-moved"],
  );
});

test("allowlist excuses matching violations and reports stale or malformed entries", () => {
  const violations = [
    { operationId: "a_create", path: "body.x", rule: "required-added", message: "" },
    { operationId: "b_create", path: "body.y", rule: "field-removed", message: "" },
  ];
  const result = applyAllowlist(violations, [
    { operationId: "a_create", path: "body.x", reason: "never sent by any released client" },
    { operationId: "c_create", path: "body.z", reason: "fixed long ago" },
    { operationId: "d_create", path: "body.w", reason: " " },
  ]);
  assert.deepEqual(
    result.failing.map((v) => v.operationId),
    ["b_create"],
  );
  assert.deepEqual(
    result.excused.map((v) => v.operationId),
    ["a_create"],
  );
  assert.deepEqual(
    result.stale.map((entry) => entry.operationId),
    ["c_create", "d_create"],
  );
  assert.deepEqual(result.problems, ['entry 2 needs a non-empty string "reason"']);
  assert.deepEqual(applyAllowlist([], {}).problems, ["allowlist must be a JSON array"]);
});

test("picks the highest semver cli tag, with releases above their prereleases", () => {
  assert.equal(
    latestCliTag(["cli-v0.7.5", "cli-v0.10.0-rc.2", "cli-v0.9.9", "sdk-v9.0.0", "cli-vbad"]),
    "cli-v0.10.0-rc.2",
  );
  assert.equal(latestCliTag(["cli-v0.10.0-rc.2", "cli-v0.10.0"]), "cli-v0.10.0");
  assert.equal(latestCliTag(["sdk-v1.0.0"]), undefined);
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
  input: z.object({ body: z.object({
    name: z.string(),
    kind: z.enum(["ops", "release"]).default("release"),
  }).strict() }),
}];
`,
    );
    const snapshot = await loadRequestContractSnapshot({ repoRoot, srcDir });
    const body = snapshot.things_create.input.properties.body;
    assert.deepEqual(body.required, ["name"]);
    assert.equal(body.additionalProperties, false);
    assert.deepEqual(body.properties.kind.enum, ["ops", "release"]);
  } finally {
    rmSync(srcDir, { recursive: true, force: true });
  }
});
