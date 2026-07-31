import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appScope, createRepository } from "../index";
import type { ApprovalCommit } from "./approval-types";
import { createLocalD1, type LocalD1 } from "./test-d1";
import { type SeededTenants, seedTwoTenants } from "./test-seed";

/**
 * An Approval-gated Variant edit must be all-or-nothing with its parent Flag's
 * version bump.
 *
 * `updateVariant` reads the Flag version, then commits a batch whose `flags`
 * statement carries the version CAS. If a competing writer bumps the version in
 * between, a CAS that lives only on the LATER statement cannot un-commit the
 * EARLIER Variant mutation: the Variant row changes, the bump is lost, no Review
 * row is written, the Request stays `pending` (so the same edit can be applied
 * twice) — and the caller is told `null`, "not applied". That disguised outcome
 * is exactly what ADR-0036 forbids.
 *
 * The interleaving here is DETERMINISTIC, not a sleep or a Promise.all: the D1
 * binding is wrapped so the competing bump lands inside the window, between the
 * repository's reads and its batch. A test that cannot place the write in that
 * window proves nothing about the race.
 */

const NOW = "2026-07-03T09:00:00.000Z";
const REVIEWER = "user_race_owner";
const MARKER = "AUDIT-RACE-MARKER";

let local: LocalD1;
let seed: SeededTenants;

beforeEach(async () => {
  local = await createLocalD1();
  seed = await seedTwoTenants(local.d1);
});

afterEach(async () => {
  await local.dispose();
});

async function seedReviewerAndRequest(): Promise<string> {
  await local.d1
    .prepare("INSERT INTO app_memberships (app_id, user_id, role, created_at) VALUES (?,?,?,?)")
    .bind(seed.a.appId, REVIEWER, "owner", NOW)
    .run();
  const created = await createRepository(local.d1).approvals.createRequest(appScope(seed.a.appId), {
    id: "apr_race",
    operation: "flag_variants_update",
    targetType: "flag_variant",
    targetId: seed.a.variantId,
    targetVersion: "1",
    policyContexts: "[]",
    diff: JSON.stringify({ current: {}, proposed: {} }),
    status: "pending",
    proposedBy: "user_race_proposer",
    proposedVia: "api_key",
    proposedAt: NOW,
    idempotencyKey: "idem_race",
    requestHash: "sha256:race",
  });
  if (!created.ok) throw new Error("seed: Approval Request was not created");
  return created.request.id;
}

function commitFor(requestId: string): ApprovalCommit {
  return {
    requestId,
    reviewId: "rev_race_01",
    action: "approve_and_apply",
    reviewedBy: REVIEWER,
    reviewedVia: "api_key",
    reviewedAt: NOW,
    reason: null,
    idempotencyKey: "idem_race_review",
    requestHash: "sha256:race",
    resultingTargetVersion: "2",
    resultingResourceType: "flag_variant",
    resultingResourceId: seed.a.variantId,
    policyContexts: [],
  };
}

/**
 * A D1 binding that lands `competing` exactly once, immediately before the first
 * `batch` — i.e. after `updateVariant` has read the Variant and the Flag version
 * and before any of its statements commit.
 */
function d1WithWriteBeforeFirstBatch(d1: D1Database, competing: () => Promise<unknown>) {
  let fired = false;
  return new Proxy(d1, {
    get(target, property, receiver) {
      if (property !== "batch") return Reflect.get(target, property, receiver);
      return async (statements: unknown[]) => {
        if (!fired) {
          fired = true;
          await competing();
        }
        return (target as D1Database).batch(statements as never);
      };
    },
  }) as D1Database;
}

async function readState() {
  const variant = await local.d1
    .prepare("SELECT description FROM variants WHERE id = ?")
    .bind(seed.a.variantId)
    .first<{ description: string | null }>();
  const flag = await local.d1
    .prepare("SELECT version FROM flags WHERE id = ?")
    .bind(seed.a.flagId)
    .first<{ version: number }>();
  const request = await local.d1
    .prepare("SELECT status FROM approval_requests WHERE id = ?")
    .bind("apr_race")
    .first<{ status: string }>();
  const reviews = await local.d1.prepare("SELECT id FROM approval_reviews").all();
  return { variant, flag, request, reviews: reviews.results.length };
}

describe("an Approval-gated Variant edit is atomic with its Flag version bump", () => {
  it("commits nothing when a competing Flag version bump lands in the window", async () => {
    const requestId = await seedReviewerAndRequest();
    const racyD1 = d1WithWriteBeforeFirstBatch(local.d1, () =>
      local.d1
        .prepare("UPDATE flags SET version = version + 1 WHERE app_id = ? AND id = ?")
        .bind(seed.a.appId, seed.a.flagId)
        .run(),
    );

    const applied = await createRepository(racyD1).flags.updateVariant(
      appScope(seed.a.appId),
      seed.a.flagId,
      "control",
      { description: MARKER },
      { approval: commitFor(requestId) },
    );

    expect(applied).toBeNull();
    const state = await readState();
    // The report and the disk must agree: "not applied" means the Variant was
    // NOT mutated.
    expect(state.variant?.description).toBeNull();
    // Only the competing writer's bump; the Approval's is correctly absent
    // rather than silently dropped.
    expect(state.flag?.version).toBe(2);
    expect(state.request?.status).toBe("pending");
    expect(state.reviews).toBe(0);
  });

  it("positive control: the same edit applies when nothing races it", async () => {
    const requestId = await seedReviewerAndRequest();

    const applied = await createRepository(local.d1).flags.updateVariant(
      appScope(seed.a.appId),
      seed.a.flagId,
      "control",
      { description: MARKER },
      { approval: commitFor(requestId) },
    );

    expect(applied).toMatchObject({ description: MARKER });
    const state = await readState();
    expect(state.variant?.description).toBe(MARKER);
    expect(state.flag?.version).toBe(2);
    expect(state.request?.status).toBe("applied");
    expect(state.reviews).toBe(1);
  });
});
