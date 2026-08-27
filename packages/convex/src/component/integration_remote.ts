import { ConvexConfigSnapshotSchema } from "@splitch/sdk/local-evaluation";
import { internal } from "./_generated/api";
import { type ActionCtx, env } from "./_generated/server";

export async function syncHandler(ctx: ActionCtx): Promise<number> {
  const integration = await ctx.runQuery(internal.integration.get, {});
  if (!integration || integration.state === "revoked")
    throw new Error("@splitch/convex is not installed");
  const response = await fetch(`${integration.endpoint}/api/integrations/convex/snapshot`, {
    headers: {
      ...requestHeaders(),
      ...(integration.snapshotVersion === undefined
        ? {}
        : { "if-none-match": `"${integration.snapshotVersion}"` }),
    },
    redirect: "error",
  });
  if (response.status === 304) return integration.snapshotVersion ?? 0;
  const payload = await responseJson(response, "sync Convex configuration");
  const snapshot = ConvexConfigSnapshotSchema.parse(payload);
  await ctx.runMutation(internal.integration.commitSnapshot, {
    payload: JSON.stringify(snapshot),
  });
  return snapshot.environmentVersion;
}

export function requestHeaders(): Record<string, string> {
  if (!env.SPLITCH_API_KEY) throw new Error("SPLITCH_API_KEY is required for @splitch/convex");
  return { authorization: `Bearer ${env.SPLITCH_API_KEY}`, "content-type": "application/json" };
}

export async function responseJson(response: Response, operation: string): Promise<unknown> {
  if (!response.ok)
    throw new Error(`${operation} failed with HTTP ${response.status}: ${await response.text()}`);
  return response.status === 204 ? null : response.json();
}

export function normalizedEndpoint(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" && url.hostname !== "localhost")
    throw new Error("SPLITCH_ENDPOINT must use HTTPS");
  return url.toString().replace(/\/$/, "");
}

export function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

/**
 * `convex_installations_create` requires both data-plane scopes, because the
 * mounted API Key is this component's only credential: it authenticates
 * evaluation and Metric Event delivery alike. Delivery runs after the caller's
 * Mutation has committed, so an evaluate-only Key would let `track()` return a
 * receipt and then send every Metric Event terminal hours later, where nobody
 * is looking. Turn that refusal into the sentence that names the fix.
 */
export function installRejected(status: number, body: string): Error {
  if (missingWriteScope(body))
    return new Error(
      "@splitch/convex requires an API Key holding both the data-plane:evaluate and " +
        "data-plane:write scopes; the mounted SPLITCH_API_KEY is missing data-plane:write, " +
        "which delivers the Metric Events track() queues. Mint a Key with both scopes, set it " +
        `as SPLITCH_API_KEY, and rerun install. Response: ${body}`,
    );
  return new Error(`install Convex integration failed with HTTP ${status}: ${body}`);
}

function missingWriteScope(body: string): boolean {
  let parsed: { code?: unknown; details?: { heldScopes?: unknown } };
  try {
    parsed = JSON.parse(body) as typeof parsed;
  } catch {
    // Not a contract error body. Report the response verbatim rather than
    // asserting a cause it never stated.
    return false;
  }
  if (parsed.code !== "INSUFFICIENT_SCOPES") return false;
  const held = parsed.details?.heldScopes;
  return !Array.isArray(held) || !held.includes("data-plane:write");
}
