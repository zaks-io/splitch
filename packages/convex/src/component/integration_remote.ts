import { ConvexConfigSnapshotSchema } from "@splitch/contracts";
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
