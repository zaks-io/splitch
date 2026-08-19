/**
 * Stub the global `fetch` at the fixture seam so tests never hit a real edge.
 * Named in SPL-336: transport stubbed at the fixture seam (not a live test server).
 */

const EVALUATE_BODY = JSON.stringify({ variant: true });
const EVALUATE_ALL_BODY = JSON.stringify({
  evaluations: {
    "new-checkout": {
      variant: true,
      variantName: "treatment",
      reason: "SPLIT",
      errorCode: null,
      exposureTicket: "ticket-convex-1",
      exposureIdentity: "identity-convex-1",
    },
    "legacy-banner": {
      variant: null,
      variantName: null,
      reason: "DISABLED",
      errorCode: null,
      exposureTicket: null,
      exposureIdentity: null,
    },
  },
});

export type FetchCall = {
  url: string;
  method: string;
  authorization: string | null;
};

function requestUrl(input: RequestInfo | URL): string {
  return String(input instanceof Request ? input.url : input);
}

function requestMethod(input: RequestInfo | URL, init?: RequestInit): string {
  return init?.method ?? (input instanceof Request ? input.method : "GET");
}

function requestHeaders(input: RequestInfo | URL, init?: RequestInit): Headers {
  return new Headers(init?.headers ?? (input instanceof Request ? input.headers : {}));
}

function evaluateAllResponse(): Response {
  return new Response(EVALUATE_ALL_BODY, {
    status: 200,
    headers: {
      "content-type": "application/json",
      etag: '"convex-fixture-1"',
    },
  });
}

function evaluateResponse(): Response {
  return new Response(EVALUATE_BODY, {
    status: 200,
    headers: {
      "content-type": "application/json",
      "x-run-id": "run-convex-1",
      "x-variant-name": "treatment",
    },
  });
}

function stubbedEdgeResponse(url: string): Response {
  if (url.includes("/api/sdk/evaluate-all")) {
    return evaluateAllResponse();
  }
  if (url.includes("/api/sdk/evaluate")) {
    return evaluateResponse();
  }
  return new Response(JSON.stringify({ error: "unexpected path" }), { status: 404 });
}

export function stubSplitchEdgeFetch(): {
  calls: FetchCall[];
  restore: () => void;
} {
  const calls: FetchCall[] = [];
  const previous = globalThis.fetch;

  // Regular function (not arrow): replicate host-fetch receiver identity.
  // Browsers / workerd throw Illegal invocation when fetch is called detached
  // from its global; a plain arrow would silently pass and hide that class of
  // bug (SPL-321). The SDK must `.bind(globalThis)` at its default-fetch seam.
  const windowLikeFetch = async function (
    this: unknown,
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    if (this !== globalThis) {
      throw new TypeError("Failed to execute 'fetch' on 'Window': Illegal invocation");
    }
    const url = requestUrl(input);
    calls.push({
      url,
      method: requestMethod(input, init),
      authorization: requestHeaders(input, init).get("authorization"),
    });
    return stubbedEdgeResponse(url);
  };

  globalThis.fetch = windowLikeFetch as typeof fetch;

  return {
    calls,
    restore: () => {
      globalThis.fetch = previous;
    },
  };
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function assertEvaluationEntry(flagKey: string, entry: unknown): void {
  const row = requireObject(entry, `evaluations[${flagKey}]`);
  if (typeof row.reason !== "string") {
    throw new Error(`evaluations[${flagKey}].reason must be a string`);
  }
  if (!("variant" in row) || !("variantName" in row) || !("exposureTicket" in row)) {
    throw new Error(`evaluations[${flagKey}] is missing required fields`);
  }
}

/** Assert a Precomputed Evaluations object is valid browser bootstrap input. */
export function assertBootstrapShape(payload: unknown): asserts payload is {
  context: {
    targetingKey: string;
    idType: string;
    attributes: Record<string, unknown>;
  };
  evaluations: Record<
    string,
    {
      variant: unknown;
      variantName: string | null;
      reason: string;
      errorCode: string | null;
      exposureTicket: string | null;
    }
  >;
  etag: string;
} {
  const record = requireObject(payload, "bootstrap payload");
  requireNonEmptyString(record.etag, "bootstrap payload.etag");
  const context = requireObject(record.context, "bootstrap payload.context");
  requireNonEmptyString(context.targetingKey, "bootstrap context.targetingKey");
  requireNonEmptyString(context.idType, "bootstrap context.idType");
  requireObject(context.attributes, "bootstrap context.attributes");
  const evaluations = requireObject(record.evaluations, "bootstrap payload.evaluations");
  for (const [flagKey, entry] of Object.entries(evaluations)) {
    assertEvaluationEntry(flagKey, entry);
  }
}
