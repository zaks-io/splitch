import { createDb } from "./client";
import { makeClaimStateRepo } from "./claim-state";
import { makeCredentialRepo } from "./credentials";
import { makeExperimentRepo } from "./experiments";
import { makeFlagRepo } from "./flags";
import { makeIdentityRepo } from "./identity";
import { makePrivacyRepo } from "./privacy";

/**
 * The single tenant-isolation seam (ADR-0018).
 *
 * `createRepository` is the ONLY public entry into D1 access. It binds the raw
 * Drizzle client internally (never returning it) and hands back a `Repository`
 * whose every tenant-scoped method demands a scope value object built by
 * `appScope` / `envScope`. There is no public method that returns the raw
 * client or runs an arbitrary query, so a cross-App or app_id-less read is
 * unconstructible by signature — the structural property SPL-11 is built around.
 *
 * This is also the designated migration boundary: a later move to Postgres+RLS
 * swaps the client and the scope-bound builders here; callers, which only ever
 * see this `Repository` shape, are unaffected.
 */
export function createRepository(d1: D1Database) {
  const db = createDb(d1);
  return {
    flags: makeFlagRepo(db),
    experiments: makeExperimentRepo(db, d1),
    credentials: makeCredentialRepo(db),
    claim: makeClaimStateRepo(d1),
    identity: makeIdentityRepo(db, d1),
    privacy: makePrivacyRepo(db),
  };
}

export type Repository = ReturnType<typeof createRepository>;
