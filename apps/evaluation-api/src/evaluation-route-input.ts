import type {
  DataPlaneEvaluateRequest,
  EvaluateAllRequest,
  EvaluationContext,
  TestEvaluationRequest,
} from "@splitch/contracts";

export interface TestEvaluationRouteInput {
  readonly params: { appId: string; environmentId: string; flagKey: string };
  readonly body: TestEvaluationRequest;
}

export function evaluationRouteInput(input: unknown): { body: DataPlaneEvaluateRequest } {
  const body = record(record(input).body);
  return {
    body: {
      appId: optionalStringField(body, "appId"),
      flagKey: stringField(body, "flagKey"),
      targetingKey: stringField(body, "targetingKey"),
      idType: stringField(body, "idType"),
      attributes: record(body.attributes) as EvaluationContext["attributes"],
    },
  };
}

export function evaluateAllRouteInput(input: unknown): { body: EvaluateAllRequest } {
  const body = record(record(input).body);
  return {
    body: {
      appId: optionalStringField(body, "appId"),
      targetingKey: stringField(body, "targetingKey"),
      idType: stringField(body, "idType"),
      attributes: record(body.attributes ?? {}) as EvaluateAllRequest["attributes"],
    },
  };
}

export function cachedEvaluationTelemetryRouteInput(input: unknown): {
  body: { flagKey: string; idempotencyKey: string };
} {
  const body = record(record(input).body);
  return {
    body: {
      flagKey: stringField(body, "flagKey"),
      idempotencyKey: stringField(body, "idempotencyKey"),
    },
  };
}

export function testEvaluationRouteInput(input: unknown): TestEvaluationRouteInput {
  const root = record(input);
  const params = record(root.params);
  const body = record(root.body);
  const evaluationContext = body.evaluationContext;
  if (typeof evaluationContext !== "object" || evaluationContext === null) {
    throw new Error("evaluation-api: missing evaluationContext");
  }
  return {
    params: {
      appId: stringField(params, "appId"),
      environmentId: stringField(params, "environmentId"),
      flagKey: stringField(params, "flagKey"),
    },
    body: { evaluationContext: evaluationContext as TestEvaluationRequest["evaluationContext"] },
  };
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("evaluation-api: expected parsed object input");
  }
  return value as Record<string, unknown>;
}

function stringField(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  if (typeof field !== "string" || field.length === 0) {
    throw new Error(`evaluation-api: missing ${key}`);
  }
  return field;
}

function optionalStringField(value: Record<string, unknown>, key: string): string | undefined {
  const field = value[key];
  if (field === undefined) return undefined;
  if (typeof field !== "string" || field.length === 0) {
    throw new Error(`evaluation-api: invalid ${key}`);
  }
  return field;
}
