import { describe, expect, it } from "vitest";
import { appScope, createRepository, envScope } from "../index";
import { createLocalD1 } from "./test-d1";

/**
 * Type-level proof that "missing app_id" / "wrong scope" is UNCOMPILABLE.
 *
 * These `@ts-expect-error` lines are checked by `tsc` (the typecheck gate): if
 * any of the forbidden calls ever became legal, the `@ts-expect-error` would be
 * unused and `tsc` would fail. So the gate enforces the property — a
 * tenant-scoped read cannot be issued without the right scope value object.
 *
 * The assertions live in functions that are TYPE-CHECKED but never CALLED, so no
 * D1 binding is needed; the proof is entirely static. The `it` blocks below only
 * assert that these proof functions exist, keeping the file a real test target.
 */

declare const d1: D1Database;

// Never executed — present only so `tsc` checks the calls below.
function _appScopeIsRequired(): void {
  const repo = createRepository(d1);

  // OK: an App scope satisfies an App-scoped read.
  void repo.flags.getFlag(appScope("app_1"), "flag_1");

  // @ts-expect-error — getFlag requires a TenantScope; a bare string is not one.
  void repo.flags.getFlag("app_1", "flag_1");

  // @ts-expect-error — the scope argument is mandatory; it cannot be omitted.
  void repo.flags.getFlag();
}

function _perEnvScopeRejectsAppOnlyScope(): void {
  const repo = createRepository(d1);

  // OK: an EnvScope satisfies a per-Environment read.
  void repo.experiments.getRun(envScope("app_1", "env_1"), "run_1");

  // @ts-expect-error — getRun needs an EnvScope (app_id AND environment_id);
  // an App-only scope is missing environmentId and is rejected.
  void repo.experiments.getRun(appScope("app_1"), "run_1");

  // @ts-expect-error — listApiKeys is per-Environment; an App scope is too weak.
  void repo.credentials.listApiKeys(appScope("app_1"));
}

function _rawClientIsUnreachable(): void {
  const repo = createRepository(d1);

  // @ts-expect-error — there is no `.db` / raw-client escape hatch on the repo.
  void repo.db;

  // @ts-expect-error — and no arbitrary-query method on a scoped table.
  void repo.flags.flags.select;
}

function _runSnapshotUpdateIsUnreachable(): void {
  const repo = createRepository(d1);
  const scope = envScope("app_1", "env_1");

  // @ts-expect-error — Run snapshots expose read + insert only, never generic UPDATE.
  void repo.experiments.runs.update(scope, { controlVariantId: "variant_other" });

  void repo.experiments.updateRunStatus(scope, "run_1", {
    status: "ended",
    endedAt: "2026-07-30T00:00:00.000Z",
    // @ts-expect-error — the narrow lifecycle method cannot mutate frozen snapshot fields.
    controlVariantId: "variant_other",
  });
}

describe("scope is required by type (compile-time proof)", () => {
  it("the type-level proofs are present and compiled", () => {
    expect(typeof _appScopeIsRequired).toBe("function");
    expect(typeof _perEnvScopeRejectsAppOnlyScope).toBe("function");
    expect(typeof _rawClientIsUnreachable).toBe("function");
    expect(typeof _runSnapshotUpdateIsUnreachable).toBe("function");
  });

  it("does not expose a runtime Run snapshot update escape hatch", async () => {
    const local = await createLocalD1();
    try {
      const repo = createRepository(local.d1);
      expect(repo.experiments.runs).not.toHaveProperty("update");
      expect(repo.experiments).toHaveProperty("updateRunStatus");
    } finally {
      await local.dispose();
    }
  });
});
