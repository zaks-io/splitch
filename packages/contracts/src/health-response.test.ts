import { describe, expect, it } from "vitest";
import { createHealthResponse, HealthResponseSchema } from "./health-response";

const commitSha = "a".repeat(40);

describe("HealthResponseSchema", () => {
  it("requires immutable deployed revision evidence for hosted targets", () => {
    expect(() => createHealthResponse("worker", "shared-preview")).toThrow(
      /deployedCommitSha is required/,
    );
    expect(() => createHealthResponse("worker", "production")).toThrow(
      /deployedCommitSha is required/,
    );
  });

  it("accepts a full deployed commit SHA for hosted targets", () => {
    expect(createHealthResponse("worker", "shared-preview", commitSha)).toEqual({
      ok: true,
      platformTarget: "shared-preview",
      service: "worker",
      deployedCommitSha: commitSha,
    });
  });

  it("rejects mutable refs and abbreviated SHAs", () => {
    for (const deployedCommitSha of ["main", "a".repeat(12), "A".repeat(40)]) {
      expect(
        HealthResponseSchema.safeParse({
          ok: true,
          platformTarget: "shared-preview",
          service: "worker",
          deployedCommitSha,
        }).success,
      ).toBe(false);
    }
  });

  it("keeps local health independent of deploy metadata", () => {
    expect(createHealthResponse("worker", "local")).toEqual({
      ok: true,
      platformTarget: "local",
      service: "worker",
      deployedCommitSha: undefined,
    });
  });
});
