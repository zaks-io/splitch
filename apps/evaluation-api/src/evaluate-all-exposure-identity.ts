import type {
  EvaluateAllEntry,
  EvaluateAllRequest,
  EvaluateAllResponseSchema,
} from "@splitch/contracts";

/**
 * ETag material excludes Exposure Ticket bytes but includes their stable opaque
 * identity. Ticket issued_at remints inside the coarse refresh window stay
 * cache hits, while the window refreshes unread tickets before expiry and a
 * same-Variant Experiment Run rollover cannot preserve an obsolete ticket.
 * Evaluation Context is included so a tag is never reusable across contexts
 * (docs/spec/sdk/evaluate-all-endpoint.md).
 */
export function etagMaterial(
  body: ReturnType<typeof EvaluateAllResponseSchema.parse>,
  context: {
    appId: string;
    environmentId: string;
    targetingKey: string;
    idType: string;
    attributes: EvaluateAllRequest["attributes"];
  },
  ticketRefreshWindow: number | null,
): string {
  const keys = Object.keys(body.evaluations).sort();
  const evaluations: Record<
    string,
    {
      variant: EvaluateAllEntry["variant"];
      variantName: EvaluateAllEntry["variantName"];
      reason: EvaluateAllEntry["reason"];
      errorCode: EvaluateAllEntry["errorCode"];
      exposureIdentity: EvaluateAllEntry["exposureIdentity"];
    }
  > = {};
  for (const key of keys) {
    const entry = body.evaluations[key];
    if (entry === undefined) continue;
    evaluations[key] = {
      variant: entry.variant,
      variantName: entry.variantName,
      reason: entry.reason,
      errorCode: entry.errorCode,
      exposureIdentity: entry.exposureIdentity,
    };
  }
  return JSON.stringify({
    appId: context.appId,
    environmentId: context.environmentId,
    targetingKey: context.targetingKey,
    idType: context.idType,
    attributes: canonicalizeJson(context.attributes),
    ticketRefreshWindow,
    evaluations,
  });
}

function canonicalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeJson);
  if (value !== null && typeof value === "object") {
    const recordValue = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(recordValue).sort()) {
      out[key] = canonicalizeJson(recordValue[key]);
    }
    return out;
  }
  return value;
}

export async function strongEtag(canonical: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  const hex = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `"${hex}"`;
}

export function ifNoneMatchMatches(header: string | null, etag: string): boolean {
  if (header === null || header.trim() === "") return false;
  if (header.trim() === "*") return true;
  return header
    .split(",")
    .map((part) => part.trim())
    .some((part) => part === etag || part === `W/${etag}`);
}
