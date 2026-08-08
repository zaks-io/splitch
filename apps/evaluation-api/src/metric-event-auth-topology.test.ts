import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const accessControlMatrix = readFileSync(
  new URL("../../../docs/spec/control-plane/access-control-matrix.md", import.meta.url),
  "utf8",
).replace(/\s+/g, " ");

describe("Metric Event auth topology documentation", () => {
  it("assigns public credential and Client Key origin enforcement to Evaluation", () => {
    expect(accessControlMatrix).toContain(
      "Evaluation authenticates the data-plane credential and enforces the Client Key origin allow-list at the public edge",
    );
  });

  it("assigns post-delegation Metric Event validation and persistence to Event Ingest", () => {
    expect(accessControlMatrix).toContain(
      "Event Ingest owns schema, rate, identity, and storage validation and persistence after Evaluation forwards the authenticated caller identity",
    );
  });
});
