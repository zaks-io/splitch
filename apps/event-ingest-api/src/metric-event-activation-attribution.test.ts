import { activationConfigKey } from "@splitch/contracts";
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

const trustedFixture = () => makeMetricEventFixture({}, "api_key");

describe("Activation Run attribution", () => {
  /**
   * Ingest has always attributed by the Assignment's Run; the break was upstream,
   * in a config store that published only the live Run's binding (the guard for
   * that lives in control-plane-api's config-store-activation.test.ts). These pin
   * the ingest half: a holdover's Assignment is pinned to the Run it was first
   * exposed under and is never rewritten, so an ended Run's binding has to be the
   * one that matches.
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
    await seedMetricEventAssignment(fixture, {
      experimentId: "exp_signup",
      runId: "run_ended",
      variant: "treatment",
    });

    const response = await sendActivation(fixture, metricEventBody());

    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ activatedRuns: 1 });
    expect([...fixture.claims.values()][0]?.activationRows).toEqual([
      expect.objectContaining({ run_id: "run_ended", variant: "treatment" }),
    ]);
  });

  // is_holdover reports whether the SDK replayed a stored Variant instead of
  // calling assign(). It is an Exposure-row signal and is 0 on every Activation
  // row (docs/spec/contracts/storage-schemas-tinybird.md).
  it("stamps is_holdover 0 even when the Run that owns the Assignment has ended", async () => {
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
      expect.objectContaining({ run_id: "run_signup", is_holdover: 0 }),
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
   * and sent the last diagnosis at the wrong step entirely. An API Key gets the
   * step that failed; a Client Key does not, because the distinction between
   * "no Run activates on this" and "this Entity is not enrolled" is exactly the
   * oracle an anonymous caller would enumerate.
   */
  it("names the unpublished Environment configuration", async () => {
    const fixture = await trustedFixture();

    const response = await sendActivation(fixture, metricEventBody());

    expect(response.status).toBe(503);
    expect(await errorMessage(response)).toBe(
      "Activation configuration has not been published for this Environment",
    );
  });

  it("names an Event Definition no Run activates on", async () => {
    const fixture = await trustedFixture();
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

    expect(response.status).toBe(409);
    expect(response.headers.get("retry-after")).toBeNull();
    expect(await errorMessage(response)).toBe(
      "No Experiment Run uses this Event Definition for Activation",
    );
  });

  it("names an Entity type no Run using this Event Definition targets", async () => {
    const fixture = await trustedFixture();
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

    expect(response.status).toBe(409);
    expect(response.headers.get("retry-after")).toBeNull();
    expect(await errorMessage(response)).toBe(
      "Activation Entity type does not match any Experiment Run using this Event Definition",
    );
  });

  /**
   * The Assignment exists, but it is pinned to a Run that Activation binding
   * no longer names (e.g. a retired Run) — a permanent mismatch, not a race.
   * It hits the same "no Exposure for this Entity" branch as the in-flight
   * case below, so the guard has to make it retryable on the wire too rather
   * than only for the transient sub-case.
   */
  it("makes an Assignment pinned to a retired Run retryable for an API Key, unlike a misconfiguration", async () => {
    const fixture = await trustedFixture();
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
    expect(response.headers.get("retry-after")).toBe("1");
    expect(await response.json()).toEqual({
      code: "SERVICE_UNAVAILABLE",
      message: "No Experiment Run using this Event Definition has an Exposure for this Entity",
      details: { retryAfterMs: 1000 },
    });
  });

  /**
   * The motivating case for this PR (ADR-0058): an SDK that drains Exposures
   * asynchronously can land an Activation for an Entity whose own Exposure is
   * still in flight, so its Assignment has not been written yet at all — not
   * pinned to the wrong Run, simply absent. This is the one resolution
   * failure a correct caller hits on a correctly configured Experiment, and
   * it has to be retryable on the wire, not just in prose, or the caller
   * cannot tell it from the two permanent misconfigurations above without
   * parsing English.
   */
  it("makes an Entity with no Assignment yet retryable for an API Key, unlike a misconfiguration", async () => {
    const fixture = await trustedFixture();
    fixture.config.set(
      activationConfigKey(METRIC_APP_ID, METRIC_ENVIRONMENT_ID),
      activationConfig(),
    );

    const response = await sendActivation(fixture, metricEventBody());

    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("1");
    expect(await response.json()).toEqual({
      code: "SERVICE_UNAVAILABLE",
      message: "No Experiment Run using this Event Definition has an Exposure for this Entity",
      details: { retryAfterMs: 1000 },
    });
  });

  /**
   * The API-Key 503 above must not reach here: a status that fires exactly when
   * THIS Entity has no Exposure would answer "is this Entity enrolled?" one
   * request at a time (ADR-0018).
   */
  it("tells a Client Key nothing that distinguishes an unexposed Entity", async () => {
    const unexposed = await makeMetricEventFixture();
    unexposed.config.set(
      activationConfigKey(METRIC_APP_ID, METRIC_ENVIRONMENT_ID),
      activationConfig(),
    );
    await seedMetricEventAssignment(unexposed, {
      experimentId: "exp_signup",
      runId: "run_retired",
      variant: "treatment",
    });
    const unpublished = await makeMetricEventFixture();

    const responses = await Promise.all([
      sendActivation(unexposed, metricEventBody()),
      sendActivation(unpublished, metricEventBody()),
    ]);

    expect(responses.map((response) => response.status)).toEqual([409, 409]);
    expect(responses.map((response) => response.headers.get("retry-after"))).toEqual([null, null]);
    expect(await Promise.all(responses.map((response) => response.json()))).toEqual([
      {
        code: "ACTIVATION_NOT_AVAILABLE",
        message: "Activation is not available for this Metric Event",
        details: {},
      },
      {
        code: "ACTIVATION_NOT_AVAILABLE",
        message: "Activation is not available for this Metric Event",
        details: {},
      },
    ]);
  });

  it("keeps infrastructure failures retryable", async () => {
    const fixture = await trustedFixture();
    fixture.env.ASSIGNMENTS_KV = undefined;
    fixture.config.set(
      activationConfigKey(METRIC_APP_ID, METRIC_ENVIRONMENT_ID),
      activationConfig(),
    );

    const response = await sendActivation(fixture, metricEventBody());
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("1");
    expect(body).toEqual({
      code: "SERVICE_UNAVAILABLE",
      message: "Assignment store is unavailable",
      details: { retryAfterMs: 1000 },
    });
  });
});
