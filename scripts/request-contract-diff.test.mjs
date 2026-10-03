import assert from "node:assert/strict";
import test from "node:test";
import { diffRequestContracts } from "./lib/request-contract-diff.mjs";

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
  idempotency: "none",
  input: { type: "object", properties: { body } },
  ...extra,
});
const describe = (violations) => violations.map(({ path, rule }) => `${path} ${rule}`);
const diffBodies = (before, after) =>
  describe(diffRequestContracts({ things_create: route(before) }, { things_create: route(after) }));
const tagged = (type, properties, required) =>
  strict({ type: { type: "string", const: type }, ...properties }, ["type", ...required]);

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

test("checks the required keys of a query HEAD declares for the first time", () => {
  const params = { type: "object", properties: { id: str }, required: ["id"] };
  const query = (properties, required) => ({ type: "object", properties, required });
  const input = (properties) => ({
    type: "object",
    properties,
    required: Object.keys(properties),
  });
  const released = { things_get: route(str, { input: input({ params }) }) };
  const withQuery = (schema) => ({
    things_get: route(str, { input: input({ params, query: schema }) }),
  });
  assert.deepEqual(
    diffRequestContracts(released, withQuery(query({ dryRun: { type: "boolean" } }, []))),
    [],
  );
  assert.deepEqual(
    describe(diffRequestContracts(released, withQuery(query({ tenant: str }, ["tenant"])))),
    ["query.tenant required-added"],
  );
});

test("flags a removed field only when HEAD rejects unknown keys", () => {
  const before = strict({ name: str, legacy: str }, ["name"]);
  assert.deepEqual(diffBodies(before, strict({ name: str }, ["name"])), [
    "body.legacy field-removed",
  ]);
  const stripping = { type: "object", properties: { name: str }, required: ["name"] };
  assert.deepEqual(diffBodies(before, stripping), []);
});

test("flags a stripping object that became strict, since it accepted undeclared keys", () => {
  const stripping = { type: "object", properties: { name: str }, required: ["name"] };
  assert.deepEqual(diffBodies(stripping, strict({ name: str }, ["name"])), [
    "body.* field-removed",
  ]);
  assert.deepEqual(diffBodies(stripping, stripping), []);
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
  assert.deepEqual(diffBodies(before, strict({ kind: str, mode: str })), []);
});

test("recurses through arrays of objects, records, and nullable wrappers", () => {
  const list = (properties, required) => ({ type: "array", items: strict(properties, required) });
  const before = strict({
    variants: list({ name: str }, ["name"]),
    labels: { type: "object", additionalProperties: strict({ color: str }) },
    owner: { anyOf: [strict({ id: str }, ["id"]), { type: "null" }] },
  });
  const after = strict({
    variants: list({ name: str, weight: { type: "number" } }, ["name", "weight"]),
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

test("flags a record that became a strict object or lost allowed key names", () => {
  const record = (keys) => ({
    type: "object",
    propertyNames: { type: "string", enum: keys },
    additionalProperties: str,
  });
  assert.deepEqual(diffBodies(record(["a", "b"]), strict({ a: str })), ["body.* field-removed"]);
  assert.deepEqual(diffBodies(record(["a", "b"]), record(["a"])), ["body.(key) literal-removed"]);
});

test("pairs discriminated union variants by their tag", () => {
  const before = {
    oneOf: [tagged("segment", { segmentId: str }, ["segmentId"]), tagged("everyone", {}, [])],
  };
  const after = {
    oneOf: [tagged("segment", { segmentId: str, op: str }, ["segmentId", "op"])],
  };
  assert.deepEqual(diffBodies(before, after), [
    "body.op required-added",
    "body.type variant-removed",
  ]);
  const merged = strict(
    { type: { type: "string", enum: ["segment", "everyone"] }, segmentId: str },
    ["type"],
  );
  assert.deepEqual(diffBodies(before, merged), []);
});

test("compares a released object with the closest variant of a new HEAD union", () => {
  const before = strict({ k: str }, ["k"]);
  const after = { oneOf: [tagged("a", {}, []), tagged("b", {}, [])] };
  assert.deepEqual(diffBodies(before, after), ["body.type required-added", "body.k field-removed"]);
});

test("flags narrowed primitive unions but treats integer as a number", () => {
  const before = strict({ value: { anyOf: [str, { type: "integer" }, { type: "boolean" }] } });
  const after = strict({ value: { anyOf: [{ type: "string", enum: ["a"] }, { type: "number" }] } });
  assert.deepEqual(diffBodies(before, after), [
    "body.value type-narrowed",
    "body.value type-narrowed",
  ]);
});

test("flags a field that accepted any value becoming constrained", () => {
  assert.deepEqual(diffBodies(strict({ m: {} }), strict({ m: str })), ["body.m type-narrowed"]);
  assert.deepEqual(diffBodies(strict({ m: str }), strict({ m: {} })), []);
});

test("treats an unconstrained union member as accepting every value", () => {
  const anyOrString = { anyOf: [{}, str] };
  assert.deepEqual(diffBodies(strict({ m: anyOrString }), strict({ m: str })), [
    "body.m type-narrowed",
  ]);
  assert.deepEqual(diffBodies(strict({ m: strict({ a: str }) }), strict({ m: anyOrString })), []);
});

test("fails loud on schema keywords the diff cannot reason about", () => {
  const after = { allOf: [strict({ name: str }), strict({ kind: str })] };
  assert.deepEqual(diffBodies(strict({ name: str }), after), ["body unsupported-schema"]);
});

test("flags removed and moved routes and a newly required Idempotency-Key", () => {
  const released = { a_get: route(str), b_get: route(str), c_create: route(str) };
  const head = {
    b_get: route(str, { path: "/v2/things" }),
    c_create: route(str, { idempotency: "required" }),
  };
  assert.deepEqual(
    diffRequestContracts(released, head).map(({ operationId, path, rule }) =>
      [operationId, path, rule].join(" "),
    ),
    [
      "a_get (route) route-removed",
      "b_get (route) route-moved",
      "c_create headers.Idempotency-Key required-added",
    ],
  );
});

test("treats a renamed path param as the same URL slot, still checking its values", () => {
  const withParam = (path, name, schema) =>
    route(str, {
      method: "GET",
      path,
      input: {
        type: "object",
        properties: {
          params: { type: "object", properties: { [name]: schema }, required: [name] },
        },
      },
    });
  const released = { things_get: withParam("/v1/things/:thingId", "thingId", str) };
  const renamed = { things_get: withParam("/v1/things/:thingKey", "thingKey", str) };
  assert.deepEqual(diffRequestContracts(released, renamed), []);
  const narrowed = {
    things_get: withParam("/v1/things/:thingKey", "thingKey", { type: "string", enum: ["a"] }),
  };
  assert.deepEqual(describe(diffRequestContracts(released, narrowed)), [
    "params.thingId type-narrowed",
  ]);
});
