import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const accessControlMatrix = readFileSync(
  new URL("../docs/spec/control-plane/access-control-matrix.md", import.meta.url),
  "utf8",
).replace(/\s+/g, " ");

// This checks documentation wording. Metric Event credential behavior is
// exercised in apps/event-ingest-api/src/client-key-auth.test.ts.
test("the access-control matrix assigns public credential and Client Key origin enforcement", () => {
  assert.match(
    accessControlMatrix,
    /Evaluation authenticates the data-plane credential and enforces the Client Key origin allow-list at the public edge/,
  );
});

test("the access-control matrix assigns post-delegation Metric Event handling", () => {
  assert.match(
    accessControlMatrix,
    /Event Ingest owns schema, rate, identity, and storage validation and persistence after Evaluation forwards the authenticated caller identity/,
  );
});
