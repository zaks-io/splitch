import { activationConfigKey, liveRunKey } from "@splitch/contracts";
import { describe, expect, it } from "vitest";
import {
  METRIC_APP_ID,
  METRIC_ENVIRONMENT_ID,
  makeMetricEventFixture,
  metricEventBody,
  sendActivation,
} from "./metric-event.test-fixture";
import { activationConfig, errorMessage, liveRun } from "./metric-event-activation.test-fixture";
import { seedMetricEventAssignment } from "./metric-event-assignment.test-fixture";

describe("Activation Run attribution", () => {
  /**
   * The bug this covers: attribution used to require the Assignment's Run to be
   * the LIVE Run, which a holdover can never satisfy. Its Assignment is pinned to
   * the Run it was first exposed under and is never rewritten, so every Entity
   * carried across a Run boundary silently stopped activating.
   */
  it("attributes a holdover to the Run that owns its Assignment", async () => {
    const fixture = await makeMetricEventFixture();
    fixture.config.set(
      activationConfigKey(METRIC_APP_ID, METRIC_ENVIRONMENT_ID),
      activationConfig([
        {
          eventDefinitionId: "ed_signed_up",
          experimentId: "exp_signup",
          runId: "run_ended",
          idType: "user",
        },
        {
          eventDefinitionId: "ed_signed_up",
          experimentId: "exp_signup",
          runId: "run_signup",
          idType: "user",
        },
      ]),
    );
    fixture.config.set(
      liveRunKey(METRIC_APP_ID, METRIC_ENVIRONMENT_ID, "exp_signup"),
      liveRun("run_signup"),
    );
    await seedMetricEventAssignment(fixture, {
      experimentId: "exp_signup",
      runId: "run_ended",
      variant: "treatment",
    });

    const response = await sendActivation(fixture, metricEventBody());

    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ activatedRuns: 1 });
    expect([...fixture.claims.values()][0]?.activationRows).toEqual([
      expect.objectContaining({ run_id: "run_ended", variant: "treatment", is_holdover: 1 }),
    ]);
  });

  it("marks an Entity a holdover when the Experiment has no live Run", async () => {
    const fixture = await makeMetricEventFixture();
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
    expect([...fixture.claims.values()][0]?.activationRows).toEqual([
      expect.objectContaining({ run_id: "run_signup", is_holdover: 1 }),
    ]);
  });

  it("ignores Runs bound to another Entity type instead of refusing the event", async () => {
    const fixture = await makeMetricEventFixture();
    fixture.config.set(
      activationConfigKey(METRIC_APP_ID, METRIC_ENVIRONMENT_ID),
      activationConfig([
        {
          eventDefinitionId: "ed_signed_up",
          experimentId: "exp_threads",
          runId: "run_threads",
          idType: "conversation",
        },
        {
          eventDefinitionId: "ed_signed_up",
          experimentId: "exp_signup",
          runId: "run_signup",
          idType: "user",
        },
      ]),
    );
    await seedMetricEventAssignment(fixture, {
      experimentId: "exp_signup",
      runId: "run_signup",
      variant: "control",
    });

    const response = await sendActivation(fixture, metricEventBody());

    expect(response.status).toBe(202);
    expect([...fixture.claims.values()][0]?.activationRows).toEqual([
      expect.objectContaining({ experiment_id: "exp_signup", id_type: "user" }),
    ]);
  });
});

describe("Activation resolution failures", () => {
  /**
   * These used to be one opaque "Activation configuration is unavailable", which
   * made an unpublished blob indistinguishable from a live-but-unexposed Entity
   * and sent the last diagnosis at the wrong step entirely.
   */
  it("names the unpublished Environment configuration", async () => {
    const fixture = await makeMetricEventFixture();

    const response = await sendActivation(fixture, metricEventBody());

    expect(response.status).toBe(503);
    expect(await errorMessage(response)).toBe(
      "Activation configuration has not been published for this Environment",
    );
  });

  it("names an Event Definition no Run activates on", async () => {
    const fixture = await makeMetricEventFixture();
    fixture.config.set(
      activationConfigKey(METRIC_APP_ID, METRIC_ENVIRONMENT_ID),
      activationConfig([
        {
          eventDefinitionId: "ed_other",
          experimentId: "exp_signup",
          runId: "run_signup",
          idType: "user",
        },
      ]),
    );

    const response = await sendActivation(fixture, metricEventBody());

    expect(response.status).toBe(503);
    expect(await errorMessage(response)).toBe(
      "No Experiment Run uses this Event Definition for Activation",
    );
  });

  it("names an Entity type no Run using this Event Definition targets", async () => {
    const fixture = await makeMetricEventFixture();
    fixture.config.set(
      activationConfigKey(METRIC_APP_ID, METRIC_ENVIRONMENT_ID),
      activationConfig([
        {
          eventDefinitionId: "ed_signed_up",
          experimentId: "exp_threads",
          runId: "run_threads",
          idType: "conversation",
        },
      ]),
    );

    const response = await sendActivation(fixture, metricEventBody());

    expect(response.status).toBe(503);
    expect(await errorMessage(response)).toBe(
      "Activation Entity type does not match any Experiment Run using this Event Definition",
    );
  });

  it("names a missing Exposure separately from a missing configuration", async () => {
    const fixture = await makeMetricEventFixture();
    fixture.config.set(
      activationConfigKey(METRIC_APP_ID, METRIC_ENVIRONMENT_ID),
      activationConfig(),
    );
    await seedMetricEventAssignment(fixture, {
      experimentId: "exp_signup",
      runId: "run_retired",
      variant: "treatment",
    });

    const response = await sendActivation(fixture, metricEventBody());

    expect(response.status).toBe(503);
    expect(await errorMessage(response)).toBe(
      "No Experiment Run using this Event Definition has an Exposure for this Entity",
    );
  });
});
