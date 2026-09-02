import { activationConfigKey } from "@splitch/contracts";
import { describe, expect, it } from "vitest";
import { entityMetricPrivacyFixtureFetch } from "./entity-metric-privacy.test-fixture";
import { ingestAdmissionScopeName } from "./ingest-admission-config";
import {
  METRIC_APP_ID,
  METRIC_ENVIRONMENT_ID,
  makeMetricEventFixture,
  metricEventBody,
  sendActivation,
  sendMetricEvent,
} from "./metric-event.test-fixture";
import { activationConfig } from "./metric-event-activation.test-fixture";
import { seedMetricEventAssignment } from "./metric-event-assignment.test-fixture";

describe("Activation ingest", () => {
  it("accepts one Metric Event and materializes matching live-Run Activations", async () => {
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
    expect(await response.json()).toEqual({
      accepted: true,
      duplicate: false,
      eventId: "123e4567-e89b-42d3-a456-426614174000",
      activatedRuns: 1,
    });
    expect([...fixture.claims.values()][0]).toMatchObject({
      activatedRuns: 1,
      activationRows: [
        {
          experiment_id: "exp_signup",
          run_id: "run_signup",
          id_type: "user",
          type: "activation",
          variant: "treatment",
          is_holdover: 0,
        },
      ],
    });
    expect(fixture.admissionCharges.map((charge) => charge.scope)).toEqual([
      ingestAdmissionScopeName(METRIC_APP_ID, METRIC_ENVIRONMENT_ID, "metric_events"),
      ingestAdmissionScopeName(METRIC_APP_ID, METRIC_ENVIRONMENT_ID, "raw_events"),
    ]);
  });

  it("does not claim an event before Activation configuration propagates", async () => {
    const fixture = await makeMetricEventFixture();

    const unavailable = await sendActivation(fixture, metricEventBody());

    expect(unavailable.status).toBe(503);
    expect(fixture.claims.size).toBe(0);

    fixture.config.set(
      activationConfigKey(METRIC_APP_ID, METRIC_ENVIRONMENT_ID),
      activationConfig(),
    );
    await seedMetricEventAssignment(fixture, {
      experimentId: "exp_signup",
      runId: "run_signup",
      variant: "treatment",
    });
    const retried = await sendActivation(fixture, metricEventBody());
    expect(retried.status).toBe(202);
    expect(await retried.json()).toMatchObject({ activatedRuns: 1, duplicate: false });
  });

  it("does not claim an event until the Entity has an Exposure in a matching Run", async () => {
    const fixture = await makeMetricEventFixture();
    fixture.config.set(
      activationConfigKey(METRIC_APP_ID, METRIC_ENVIRONMENT_ID),
      activationConfig(),
    );

    const unavailable = await sendActivation(fixture, metricEventBody());
    expect(unavailable.status).toBe(503);
    expect(fixture.claims.size).toBe(0);

    await seedMetricEventAssignment(fixture, {
      experimentId: "exp_signup",
      runId: "run_signup",
      variant: "control",
    });
    const retried = await sendActivation(fixture, metricEventBody());
    expect(retried.status).toBe(202);
    expect([...fixture.claims.values()][0]?.activationRows).toEqual([
      expect.objectContaining({ run_id: "run_signup", variant: "control" }),
    ]);
  });

  it("activates only matching Runs where the Entity has an Exposure", async () => {
    const fixture = await makeMetricEventFixture();
    fixture.config.set(
      activationConfigKey(METRIC_APP_ID, METRIC_ENVIRONMENT_ID),
      activationConfig([
        {
          eventDefinitionId: "ed_signed_up",
          experimentId: "exp_signup",
          runId: "run_signup",
          idType: "user",
        },
        {
          eventDefinitionId: "ed_signed_up",
          experimentId: "exp_unexposed",
          runId: "run_unexposed",
          idType: "user",
        },
      ]),
    );
    await seedMetricEventAssignment(fixture, {
      experimentId: "exp_signup",
      runId: "run_signup",
      variant: "treatment",
    });

    const response = await sendActivation(fixture, metricEventBody());

    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ activatedRuns: 1 });
    expect([...fixture.claims.values()][0]?.activationRows).toEqual([
      expect.objectContaining({ experiment_id: "exp_signup", run_id: "run_signup" }),
    ]);
  });

  it("rejects reuse of an eventId first claimed without Activation", async () => {
    const fixture = await makeMetricEventFixture();
    expect((await sendMetricEvent(fixture, metricEventBody())).status).toBe(202);

    const response = await sendActivation(fixture, metricEventBody());

    expect(response.status).toBe(409);
    const body = (await response.json()) as { code?: unknown };
    expect(body.code).toBe("EVENT_ID_CONFLICT");
  });
});

describe("Activation identity", () => {
  it("uses the retained identity hash that owns the Exposure-backed Assignment", async () => {
    const fixture = await makeMetricEventFixture();
    fixture.config.set(
      activationConfigKey(METRIC_APP_ID, METRIC_ENVIRONMENT_ID),
      activationConfig(),
    );
    const retainedHash = await seedMetricEventAssignment(fixture, {
      experimentId: "exp_signup",
      runId: "run_signup",
      variant: "treatment",
      identityEpoch: "oldest",
    });

    const response = await sendActivation(fixture, metricEventBody());

    expect(response.status).toBe(202);
    expect([...fixture.claims.values()][0]?.activationRows).toEqual([
      expect.objectContaining({ targeting_key_hash: retainedHash }),
    ]);
  });

  it("uses the configured source identity outside local development", async () => {
    const fixture = await makeMetricEventFixture({
      ENTITY_METRIC_PRIVACY: {
        idFromName: (name) => name as unknown as DurableObjectId,
        get: () => ({ fetch: entityMetricPrivacyFixtureFetch }),
      },
      EVALUATION_PRIVACY_SALT: "test-root-secret-do-not-use",
      SPLITCH_PLATFORM_TARGET: "production",
      SPLITCH_SOURCE_ID: "event-ingest-api",
    });
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
    const body = await response.json();

    expect(response.status, JSON.stringify(body)).toBe(202);
    expect([...fixture.claims.values()][0]?.activationRows).toEqual([
      expect.objectContaining({ source_id: "event-ingest-api" }),
    ]);
  });
});
