import { appScope, type Repository } from "@splitch/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type ExperimentRunHarness,
  experimentFixture,
  makeExperimentRunHarness,
} from "../src/experiment-run-test-fixture";
import { frozenAnalysisConfig } from "../src/experiment-start-analysis";
import { errorBody } from "../src/flag-definition-test-harness";
import {
  ensureMetricEventDefinition,
  type MetricEventDefinitionOptions,
} from "./metric-event-definition-fixture";
import { makePoolBindings as makeLocalBindings } from "./pool-bindings";

/**
 * Start is the last moment a source binding can be checked against the Event
 * Definition Version it will be read through for the life of the Run. Every
 * case here would otherwise freeze cleanly and then read zeros forever, which
 * is a decided result built on no data.
 */

const NOW_ISO = "2026-07-02T12:00:00.000Z";

let ctx: ExperimentRunHarness;

beforeEach(async () => {
  ctx = await makeExperimentRunHarness(makeLocalBindings);
});

afterEach(async () => ctx.h.bindings.dispose());

async function metric(
  appId: string,
  id: string,
  overrides: Record<string, unknown> = {},
  definition: MetricEventDefinitionOptions = {},
): Promise<string> {
  const kind = (overrides.kind as string | undefined) ?? "binomial";
  const eventDefinitionId =
    kind === "ratio"
      ? null
      : await ensureMetricEventDefinition(
          ctx.h.bindings.d1,
          appId,
          id,
          NOW_ISO,
          overrides.eventFieldName as string | undefined,
          definition,
        );
  const row = await ctx.repo.experiments.metrics.insert(appScope(appId), {
    id,
    appId,
    key: id,
    name: id,
    kind: "binomial",
    eventDefinitionId,
    createdAt: NOW_ISO,
    ...overrides,
  });
  return row.id;
}

async function refusal(
  appId: string,
  metricIds: string[],
  targetingKeyType = "user",
): Promise<{ code: string; details: string }> {
  const frozen = await frozenAnalysisConfig(
    ctx.repo,
    appId,
    { metrics: metricIds.map((metricId) => ({ metricId })), guardrailMetrics: [] },
    ["treatment"],
    60_000,
    targetingKeyType,
    "req_metric_binding",
  );
  if (frozen.ok) throw new Error("expected Start to refuse the Metric binding");
  const body = await errorBody(frozen.response);
  return { code: body.code, details: JSON.stringify(body.details) };
}

describe("Experiment Start Metric read batching", () => {
  it("loads an analyzed Metric set, Ratio operands, and published Versions with constant repository calls", async () => {
    const fx = await experimentFixture(ctx);
    const countIds = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        metric(
          fx.appId,
          `metric_batched_count_${index}`,
          { kind: "count", eventFieldName: "quantity" },
          { fieldName: "quantity" },
        ),
      ),
    );
    const numeratorMetricId = await metric(fx.appId, "metric_batched_numerator");
    const denominatorMetricId = await metric(fx.appId, "metric_batched_denominator");
    const ratioMetricId = await metric(fx.appId, "metric_batched_ratio", {
      kind: "ratio",
      numeratorMetricId,
      denominatorMetricId,
    });
    const calls = {
      getMetric: 0,
      getEventDefinition: 0,
      getEventDefinitionVersion: 0,
      listMetricsByIds: 0,
      listCurrentPublishedVersions: 0,
    };
    const measured: Repository = {
      ...ctx.repo,
      experiments: {
        ...ctx.repo.experiments,
        getMetric: async (...args) => {
          calls.getMetric += 1;
          return ctx.repo.experiments.getMetric(...args);
        },
        listMetricsByIds: async (...args) => {
          calls.listMetricsByIds += 1;
          return ctx.repo.experiments.listMetricsByIds(...args);
        },
      },
      eventDefinitions: {
        ...ctx.repo.eventDefinitions,
        get: async (...args) => {
          calls.getEventDefinition += 1;
          return ctx.repo.eventDefinitions.get(...args);
        },
        getVersion: async (...args) => {
          calls.getEventDefinitionVersion += 1;
          return ctx.repo.eventDefinitions.getVersion(...args);
        },
        listCurrentPublishedVersions: async (...args) => {
          calls.listCurrentPublishedVersions += 1;
          return ctx.repo.eventDefinitions.listCurrentPublishedVersions(...args);
        },
      },
    };

    const frozen = await frozenAnalysisConfig(
      measured,
      fx.appId,
      {
        metrics: [...countIds, ratioMetricId].map((metricId) => ({ metricId })),
        guardrailMetrics: [],
      },
      ["treatment"],
      60_000,
      "user",
      "req_metric_batching",
    );

    expect(frozen.ok).toBe(true);
    expect(calls).toEqual({
      getMetric: 0,
      getEventDefinition: 0,
      getEventDefinitionVersion: 0,
      listMetricsByIds: 2,
      listCurrentPublishedVersions: 1,
    });
  });
});

describe("Experiment Start refuses an unreadable Metric source binding", () => {
  it("refuses a Count Metric whose field is absent from the published Version", async () => {
    const fx = await experimentFixture(ctx);
    const id = await metric(
      fx.appId,
      "metric_absent_field",
      { kind: "count", eventFieldName: "duration_ms" },
      { fieldName: null },
    );

    const { code, details } = await refusal(fx.appId, [id]);

    expect(code).toBe("VALIDATION_ERROR");
    expect(details).toContain("duration_ms is missing or nonnumeric");
  });

  it("refuses a Revenue Metric whose field is declared as a non-numeric type", async () => {
    const fx = await experimentFixture(ctx);
    const id = await metric(
      fx.appId,
      "metric_string_field",
      { kind: "revenue", eventFieldName: "amount" },
      { fieldType: "string" },
    );

    const { code, details } = await refusal(fx.appId, [id]);

    expect(code).toBe("VALIDATION_ERROR");
    expect(details).toContain("amount is missing or nonnumeric");
  });

  it("refuses a Metric whose Entity type does not match the Run's targeting key", async () => {
    const fx = await experimentFixture(ctx);
    const id = await metric(
      fx.appId,
      "metric_session_scoped",
      { kind: "count", eventFieldName: "request_count" },
      { entityType: "session" },
    );

    const { code, details } = await refusal(fx.appId, [id], "user");

    expect(code).toBe("VALIDATION_ERROR");
    expect(details).toContain("Entity type session does not match Run Entity type user");
  });

  it("refuses a Metric whose Event Definition has no published Version", async () => {
    const fx = await experimentFixture(ctx);
    const id = await metric(
      fx.appId,
      "metric_unpublished",
      { kind: "count", eventFieldName: "quantity" },
      { publish: false },
    );

    const { code, details } = await refusal(fx.appId, [id]);

    expect(code).toBe("VALIDATION_ERROR");
    expect(details).toContain("no current published metric Event Definition");
  });

  it("refuses a legacy Ratio Metric that was never given a numerator", async () => {
    const fx = await experimentFixture(ctx);
    const denominatorId = await metric(fx.appId, "metric_legacy_denominator");
    const id = await metric(fx.appId, "metric_legacy_ratio", {
      kind: "ratio",
      denominatorMetricId: denominatorId,
    });

    const { code, details } = await refusal(fx.appId, [id]);

    expect(code).toBe("VALIDATION_ERROR");
    expect(details).toContain("has no numerator Metric");
  });

  it("refuses a Ratio operand that is missing or belongs to another App", async () => {
    const fx = await experimentFixture(ctx);
    const denominatorId = await metric(fx.appId, "metric_foreign_denominator");
    const id = await metric(fx.appId, "metric_foreign_ratio", {
      kind: "ratio",
      numeratorMetricId: "metric_from_another_app",
      denominatorMetricId: denominatorId,
    });

    const { code, details } = await refusal(fx.appId, [id]);

    expect(code).toBe("VALIDATION_ERROR");
    expect(details).toContain("metric_from_another_app is missing or cross-App");
  });

  it("refuses a Ratio operand that is itself a Ratio", async () => {
    const fx = await experimentFixture(ctx);
    const innerDenominatorId = await metric(fx.appId, "metric_inner_denominator");
    const innerNumeratorId = await metric(fx.appId, "metric_inner_numerator");
    const innerRatioId = await metric(fx.appId, "metric_inner_ratio", {
      kind: "ratio",
      numeratorMetricId: innerNumeratorId,
      denominatorMetricId: innerDenominatorId,
    });
    const id = await metric(fx.appId, "metric_nested_ratio", {
      kind: "ratio",
      numeratorMetricId: innerRatioId,
      denominatorMetricId: innerDenominatorId,
    });

    const { code, details } = await refusal(fx.appId, [id]);

    expect(code).toBe("VALIDATION_ERROR");
    expect(details).toContain(`${innerRatioId} is itself a Ratio`);
  });

  it("refuses a Ratio whose numerator and denominator are the same Metric", async () => {
    const fx = await experimentFixture(ctx);
    const operandId = await metric(fx.appId, "metric_sole_operand");
    const id = await metric(fx.appId, "metric_self_ratio", {
      kind: "ratio",
      numeratorMetricId: operandId,
      denominatorMetricId: operandId,
    });

    const { code, details } = await refusal(fx.appId, [id]);

    expect(code).toBe("VALIDATION_ERROR");
    expect(details).toContain("ratio operands must be distinct Metrics");
  });
});
