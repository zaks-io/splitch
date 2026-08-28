import { describe, expect, it } from "vitest";
import {
  createHealthResponse,
  HealthResponseSchema,
  isHostedPlatformTarget,
  isLocalPlatformTarget,
  parsePlatformTarget,
  requirePlatformTarget,
} from "./health-response";

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

describe("platform target helpers", () => {
  it("treats only explicit local and pr-ci as local defaults", () => {
    expect(isLocalPlatformTarget("local")).toBe(true);
    expect(isLocalPlatformTarget("pr-ci")).toBe(true);
    expect(isLocalPlatformTarget(undefined)).toBe(false);
    expect(isLocalPlatformTarget("shared-preview")).toBe(false);
    expect(isLocalPlatformTarget("production")).toBe(false);
    expect(isLocalPlatformTarget("staging")).toBe(false);
  });

  it("treats only shared-preview and production as hosted", () => {
    expect(isHostedPlatformTarget("shared-preview")).toBe(true);
    expect(isHostedPlatformTarget("production")).toBe(true);
    expect(isHostedPlatformTarget(undefined)).toBe(false);
    expect(isHostedPlatformTarget("local")).toBe(false);
  });

  it("requirePlatformTarget never silently substitutes local", () => {
    expect(requirePlatformTarget("local")).toBe("local");
    expect(requirePlatformTarget("pr-ci")).toBe("pr-ci");
    expect(requirePlatformTarget("shared-preview")).toBe("shared-preview");
    expect(requirePlatformTarget("production")).toBe("production");
    expect(() => requirePlatformTarget(undefined)).toThrow("SPLITCH_PLATFORM_TARGET is required");
    expect(() => requirePlatformTarget("staging")).toThrow(
      'SPLITCH_PLATFORM_TARGET "staging" is not a platform target',
    );
  });

  it("keeps parsePlatformTarget's display fallback without unlocking local defaults", () => {
    expect(parsePlatformTarget(undefined)).toBe("local");
    expect(parsePlatformTarget("staging")).toBe("local");
    expect(isLocalPlatformTarget(undefined)).toBe(false);
    expect(isLocalPlatformTarget("staging")).toBe(false);
  });
});
