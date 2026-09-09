import { randomUUID } from "node:crypto";
import { getRoute, requestBodySchemaForOperation } from "@splitch/sdk/control-plane";

export function applyOperationIdempotencyInput(
  operationId: string,
  explicitKey: string | undefined,
  input: Record<string, unknown>,
): void {
  const field = idempotencyInputField(operationId);
  if (explicitKey !== undefined) input[field] = explicitKey;

  const route = getRoute(operationId);
  if (!route || route.idempotency === "none") return;
  if (!Object.hasOwn(input, field)) input[field] = `cli_${randomUUID()}`;
}

function idempotencyInputField(operationId: string): "idempotencyKey" | "idempotency_key" {
  const schema = requestBodySchemaForOperation(operationId);
  const shape = schema && "shape" in schema ? (schema.shape as Record<string, unknown>) : undefined;
  return shape && Object.hasOwn(shape, "idempotencyKey") ? "idempotencyKey" : "idempotency_key";
}
