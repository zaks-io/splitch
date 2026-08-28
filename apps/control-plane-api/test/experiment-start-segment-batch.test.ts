import { appScope } from "@splitch/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createExperimentDraft,
  type ExperimentRunHarness,
  experimentFixture,
  makeExperimentRunHarness,
  type StartResponse,
  startExperiment,
} from "../src/experiment-run-test-fixture";
import { NOW_ISO } from "../src/flag-definition-test-harness";
import { makePoolBindings as makeLocalBindings } from "./pool-bindings";

/**
 * Draft `segmentIds` use the named domain bound
 * `PERSISTED_SEGMENT_REF_MAX_ITEMS` (256), not the generic array product cap
 * of 100. D1 refuses a statement carrying more than 100 bound parameters, which
 * made a large draft fail with `too many SQL variables` instead of starting.
 */
let ctx: ExperimentRunHarness;

/**
 * Past D1's 100-parameter cap, so an unbatched `IN (...)` genuinely errors.
 * A count under 100 would pass either way and prove nothing.
 */
const SEGMENTS = 120;

beforeEach(async () => {
  ctx = await makeExperimentRunHarness(makeLocalBindings);
});

afterEach(async () => ctx.h.bindings.dispose());

describe("control-plane Experiment Start Segment resolution", () => {
  it(`starts a Run whose draft references ${SEGMENTS} Segments`, async () => {
    const fx = await experimentFixture(ctx);
    const scope = appScope(fx.appId);
    const segmentIds: string[] = [];
    for (let index = 0; index < SEGMENTS; index += 1) {
      const id = `segment_bulk_${String(index).padStart(4, "0")}`;
      await ctx.repo.flags.segments.insert(scope, {
        id,
        appId: fx.appId,
        name: `Bulk segment ${index}`,
        conditions: JSON.stringify([{ attribute: "plan", operator: "eq", value: `tier-${index}` }]),
        createdAt: NOW_ISO,
        updatedAt: NOW_ISO,
      });
      segmentIds.push(id);
    }

    const experiment = await createExperimentDraft(ctx, fx, {
      key: "many-segments",
      allocation: { control: 50, treatment: 50 },
      segmentIds,
    });

    const started = await startExperiment(ctx, fx, experiment.id);

    // A 500 here is the unbatched failure. Asserting the rule count as well,
    // because a batching bug that dropped a batch would still return 200 and
    // then freeze a Run missing Segment rules -- which silently WIDENS the
    // audience, the same failure the dangling-reference check guards (ADR-0036).
    expect(started.status).toBe(200);
    const body = (await started.json()) as StartResponse;
    expect(body.run.targetingRules).toHaveLength(SEGMENTS);
  });
});
