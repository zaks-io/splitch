import { activationConfigKey, assignmentWriterName } from "@splitch/contracts";
import { describe, expect, it } from "vitest";
import {
  METRIC_APP_ID,
  METRIC_ENVIRONMENT_ID,
  makeMetricEventFixture,
  metricEventBody,
  sendActivation,
} from "./metric-event.test-fixture";
import { activationConfig, errorMessage } from "./metric-event-activation.test-fixture";
import { seedMetricEventAssignment } from "./metric-event-assignment.test-fixture";
import type { Env } from "./types";

const trustedFixture = () => makeMetricEventFixture({}, "api_key");

/**
 * The `ASSIGNMENTS_KV` mirror is the edge-local read ADR-0006 requires, and the
 * Assignment Store instance behind it is the authority. These pin both halves
 * of that trade: the instance is consulted when the mirror cannot answer, and
 * never when it can.
 */
describe("Activation reads of the Assignment Store instance", () => {
  /**
   * KV propagates globally rather than read-your-writes, and it caches a
   * negative lookup for up to 60s in the region that took it, so an Activation
   * that arrives just ahead of its own Exposure can read an empty mirror and
   * then keep reading its own cached miss. The instance is the authority and
   * already has the Assignment, so activation must succeed anyway — and the row
   * it emits has to carry the same attribution a mirror hit would have.
   */
  it("resolves from the Assignment Store instance when the KV mirror is still empty", async () => {
    const fixture = await trustedFixture();
    fixture.config.set(
      activationConfigKey(METRIC_APP_ID, METRIC_ENVIRONMENT_ID),
      activationConfig(),
    );
    await seedMetricEventAssignment(fixture, {
      experimentId: "exp_signup",
      runId: "run_signup",
      variant: "treatment",
      kvMirrorLags: true,
    });
    expect(fixture.assignments.size).toBe(0);

    const response = await sendActivation(fixture, metricEventBody());

    expect(response.status).toBe(202);
    expect([...fixture.claims.values()][0]?.activationRows).toEqual([
      expect.objectContaining({ run_id: "run_signup", variant: "treatment", is_holdover: 0 }),
    ]);
  });

  /**
   * The mirror blob is one merged map per Entity, so a lagging *update* is as
   * likely as a lagging create: an Entity already enrolled in one Experiment has
   * a present-but-stale blob that predates its Exposure to the next one. A
   * present blob is not an answer either, so the instance has to be consulted
   * whenever the mirror yields no bound Run — not merely when the key is absent.
   */
  it("resolves from the instance when the KV mirror holds a stale blob for another Experiment", async () => {
    const fixture = await trustedFixture();
    fixture.config.set(
      activationConfigKey(METRIC_APP_ID, METRIC_ENVIRONMENT_ID),
      activationConfig(),
    );
    await seedMetricEventAssignment(fixture, {
      experimentId: "exp_onboarding",
      runId: "run_onboarding",
      variant: "control",
    });
    await seedMetricEventAssignment(fixture, {
      experimentId: "exp_signup",
      runId: "run_signup",
      variant: "treatment",
      kvMirrorLags: true,
    });
    expect(fixture.assignments.size).toBe(1);

    const response = await sendActivation(fixture, metricEventBody());

    expect(response.status).toBe(202);
    expect([...fixture.claims.values()][0]?.activationRows).toEqual([
      expect.objectContaining({ run_id: "run_signup", variant: "treatment" }),
    ]);
  });

  /**
   * An Entity carries one retained Targeting Key hash per identity epoch but
   * Assignments are only ever written under the current one, so the historical
   * keys miss on every single Activation. Consulting the instance per missing
   * key would bill a normally enrolled Entity two cross-script hops forever,
   * against instances that can never hold data — the opposite of the
   * edge-local hot-path read ADR-0006 requires.
   */
  it("never touches the Assignment Store instance when the KV mirror already answers", async () => {
    const fixture = await trustedFixture();
    fixture.config.set(
      activationConfigKey(METRIC_APP_ID, METRIC_ENVIRONMENT_ID),
      activationConfig(),
    );
    await seedMetricEventAssignment(fixture, {
      experimentId: "exp_signup",
      runId: "run_signup",
      variant: "treatment",
    });

    const response = await sendActivation(fixture, metricEventBody());

    expect(response.status).toBe(202);
    expect(fixture.writerRequests).toEqual([]);
  });

  /**
   * One hop, to the current epoch's instance only. A historical epoch names an
   * instance that has never been written to, so asking it costs a cold-start
   * `storage.list` for a guaranteed empty answer.
   */
  it("asks exactly one Assignment Store instance when the KV mirror comes back empty", async () => {
    const fixture = await trustedFixture();
    fixture.config.set(
      activationConfigKey(METRIC_APP_ID, METRIC_ENVIRONMENT_ID),
      activationConfig(),
    );
    const targetingKeyHash = await seedMetricEventAssignment(fixture, {
      experimentId: "exp_signup",
      runId: "run_signup",
      variant: "treatment",
      kvMirrorLags: true,
    });

    const response = await sendActivation(fixture, metricEventBody());

    expect(response.status).toBe(202);
    expect(fixture.writerRequests).toEqual([
      {
        method: "GET",
        path: "/export",
        name: assignmentWriterName({ appId: METRIC_APP_ID, idType: "user", targetingKeyHash }),
      },
    ]);
  });
});

/**
 * `/export` is another Worker's response body, not a local type. If that body
 * ever renames or re-wraps its assignments map, treating the missing field as
 * "no Assignments" would report every Entity permanently unexposed while both
 * stores are healthy — a plausible wrong answer where ADR-0036 requires a loud
 * one.
 */
describe("Activation reads of a drifted Assignment Store export", () => {
  it("fails loudly when the export does not carry a readable assignments map", async () => {
    const fixture = await makeMetricEventFixture(
      { ASSIGNMENT_STORE_WRITER: renamedExportWriter() },
      "api_key",
    );
    fixture.config.set(
      activationConfigKey(METRIC_APP_ID, METRIC_ENVIRONMENT_ID),
      activationConfig(),
    );
    await seedMetricEventAssignment(fixture, {
      experimentId: "exp_signup",
      runId: "run_signup",
      variant: "treatment",
      kvMirrorLags: true,
    });

    const response = await sendActivation(fixture, metricEventBody());

    expect(response.status).toBe(503);
    expect(await errorMessage(response)).toBe("Assignment store returned an unreadable export");
    expect(fixture.claims.size).toBe(0);
  });
});

/** An instance that answers 200 with the map moved under a renamed field. */
function renamedExportWriter(): NonNullable<Env["ASSIGNMENT_STORE_WRITER"]> {
  return {
    idFromName: (name: string) => name as unknown as DurableObjectId,
    get: () => ({
      fetch: async () =>
        Response.json({ winners: { exp_signup: { runId: "run_signup", variant: "treatment" } } }),
    }),
  };
}
