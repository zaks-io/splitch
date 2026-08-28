import { FLAG_KEY, baseInput } from "./evaluate/evaluate-path-test-fixtures";

export function sdkRouteInit(
  credential?: string,
  extraHeaders: Record<string, string> = {},
  bodyOverrides: Record<string, unknown> = {},
): RequestInit {
  return {
    method: "POST",
    headers: {
      ...(credential === undefined ? {} : { authorization: `Bearer ${credential}` }),
      "content-type": "application/json",
      "idempotency-key": "test-logical-evaluation",
      ...extraHeaders,
    },
    body: JSON.stringify({
      flagKey: FLAG_KEY,
      targetingKey: baseInput().evaluationContext.targetingKey,
      idType: baseInput().evaluationContext.idType,
      attributes: baseInput().evaluationContext.attributes,
      ...bodyOverrides,
    }),
  };
}

/** evaluate-all request body: DataPlaneEvaluateRequest minus flagKey. */
export function evaluateAllRouteInit(
  credential?: string,
  extraHeaders: Record<string, string> = {},
  bodyOverrides: Record<string, unknown> = {},
): RequestInit {
  const { flagKey: _flagKey, ...body } = JSON.parse(
    String(sdkRouteInit(credential, extraHeaders, bodyOverrides).body),
  ) as Record<string, unknown>;
  return {
    method: "POST",
    headers: {
      ...(credential === undefined ? {} : { authorization: `Bearer ${credential}` }),
      "content-type": "application/json",
      "idempotency-key": "test-logical-evaluate-all",
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  };
}
