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

export function canonicalCallbackUrl(cloudUrl: string, siteUrl: string): string {
  const cloud = new URL(cloudUrl);
  if (
    cloud.protocol !== "https:" ||
    !cloud.hostname.endsWith(".convex.cloud") ||
    cloud.username ||
    cloud.password ||
    cloud.port ||
    cloud.pathname !== "/" ||
    cloud.search ||
    cloud.hash
  )
    throw new Error("CONVEX_CLOUD_URL must be a canonical HTTPS *.convex.cloud URL");
  const site = new URL(siteUrl);
  if (
    site.protocol !== "https:" ||
    site.username ||
    site.password ||
    site.port ||
    site.search ||
    site.hash
  )
    throw new Error("CONVEX_SITE_URL must be an HTTPS URL containing the component mount path");
  cloud.hostname = `${cloud.hostname.slice(0, -".convex.cloud".length)}.convex.site`;
  return new URL(
    "configuration",
    `${cloud.origin}${ensureTrailingSlash(site.pathname)}`,
  ).toString();
}

export function isCanonicalCallbackUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.hostname.endsWith(".convex.site") &&
      !url.username &&
      !url.password &&
      !url.port &&
      !url.search &&
      !url.hash &&
      url.pathname.endsWith("/configuration")
    );
  } catch {
    return false;
  }
}

export function installRejected(status: number, body: string): Error {
  return new Error(`install Convex integration failed with HTTP ${status}: ${body}`);
}
