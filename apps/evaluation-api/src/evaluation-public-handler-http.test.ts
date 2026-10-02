import type { ApiRouteContract } from "@splitch/contracts";
import { errorStatusByCode, jsonMediaTypeSchema } from "@splitch/contracts";
import { describe, expect, it } from "vitest";
import {
  EVALUATION_CLIENT_KEY_ROUTES,
  produceEvaluationClientKeyShapes,
} from "./evaluation-public-shape-producers";
import { CLIENT_KEY } from "./sdk-route-test-fixtures";

describe("evaluation public handler HTTP", () => {
  it("derives Evaluation Client Key routes from the contract registry", () => {
    expect(EVALUATION_CLIENT_KEY_ROUTES.map((route) => route.operationId).sort()).toEqual([
      "ofrep_evaluate",
      "ofrep_evaluate_bulk",
      "sdk_cached_evaluation_telemetry",
      "sdk_evaluate",
      "sdk_evaluate_all",
      "sdk_exposures",
      "sdk_verify",
    ]);
  });

  it("HTTP-produces every Evaluation Client Key success and route-declared error", async () => {
    const produced = await produceEvaluationClientKeyShapes();
    expect(Object.keys(produced).sort()).toEqual(
      EVALUATION_CLIENT_KEY_ROUTES.map((route) => route.operationId).sort(),
    );
    for (const route of EVALUATION_CLIENT_KEY_ROUTES) {
      assertProducedRouteShapes(route, produced[route.operationId]);
    }
  });
});

function assertProducedRouteShapes(
  route: ApiRouteContract,
  got: { success: unknown; errors: Record<string, unknown> } | undefined,
): void {
  if (got === undefined) throw new Error(`missing produced shapes for ${route.operationId}`);
  expect(route.output.parse(got.success)).toEqual(got.success);
  expect(Object.keys(got.errors).sort()).toEqual([...route.errors].sort());
  for (const [code, body] of Object.entries(got.errors)) {
    expect(publicErrorCode(body)).toBe(code);
    assertPublicClientKeyBody(body, route);
    assertOpenApiErrorBody(route, code, body);
  }
  assertPublicClientKeyBody(got.success, route);
}

function assertOpenApiErrorBody(route: ApiRouteContract, code: string, body: unknown): void {
  // OFREP advertises protocol-shaped error bodies; enforce those contracts here.
  // Other data-plane routes still declare ErrorResponseSchema for codes that the
  // producer may surface inside a 200 batch envelope (e.g. sdk_exposures).
  if (!route.operationId.startsWith("ofrep_")) return;
  const status = errorStatusByCode[code as keyof typeof errorStatusByCode];
  if (status === undefined) {
    throw new Error(`produced error ${code} has no HTTP status mapping`);
  }
  const response = route.openapi.responses[status];
  if (response === undefined || !("content" in response)) {
    throw new Error(
      `${route.operationId}: OpenAPI is missing a JSON error schema for HTTP ${String(status)} (${code})`,
    );
  }
  const schema = jsonMediaTypeSchema(response.content);
  if (schema === undefined) {
    throw new Error(
      `${route.operationId}: OpenAPI HTTP ${String(status)} has no application/json schema`,
    );
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new Error(
      `${route.operationId} ${code} (HTTP ${String(status)}) body failed OpenAPI schema: ${JSON.stringify(body)} :: ${parsed.error.message}`,
    );
  }
  expect(parsed.data).toEqual(body);
}

function publicErrorCode(body: unknown): string {
  if (isRecord(body) && typeof body.code === "string") return body.code;
  if (isRecord(body) && typeof body.errorCode === "string") return body.errorCode;
  if (isRecord(body) && Array.isArray(body.results)) {
    const result = body.results[0];
    if (isRecord(result) && typeof result.code === "string") return result.code;
  }
  throw new Error(`produced body has no public error code: ${JSON.stringify(body)}`);
}

function assertPublicClientKeyBody(body: unknown, route: ApiRouteContract): void {
  const raw = JSON.stringify(body);
  expect(raw).not.toContain("eventDefinitionId");
  expect(raw).not.toContain("eventDefinitionVersionId");
  expect(raw).not.toContain(CLIENT_KEY);
  if (route.operationId !== "sdk_verify") expect(raw).not.toContain("ruleId");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
