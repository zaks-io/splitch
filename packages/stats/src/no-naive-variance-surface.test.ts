import { describe, expect, it } from "vitest";

const forbiddenExportPatterns = [
  /naive/i,
  /events?AsIndependent/i,
  /events?[-_]?as[-_]?independent/i,
  /ratioOfMeans/i,
  /ratio[-_]?of[-_]?means/i,
];

describe("@splitch/stats public surface", () => {
  it("does not expose a naive variance entrypoint", async () => {
    const statsSurface = await import("./index");
    const forbiddenExports = Object.keys(statsSurface).filter((name) =>
      forbiddenExportPatterns.some((pattern) => pattern.test(name)),
    );

    expect(forbiddenExports).toEqual([]);
  });
});
