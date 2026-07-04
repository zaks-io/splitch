import { describe, expect, it } from "vitest";
import { appScope, createRepository, envScope } from "../index";

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

describe("scope is required by type (compile-time proof)", () => {
  it("the type-level proofs are present and compiled", () => {
    expect(typeof _appScopeIsRequired).toBe("function");
    expect(typeof _perEnvScopeRejectsAppOnlyScope).toBe("function");
    expect(typeof _rawClientIsUnreachable).toBe("function");
  });
});
