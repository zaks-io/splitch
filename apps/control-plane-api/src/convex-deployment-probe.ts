import { configurationCallbackDestinationError } from "./configuration-callback-transport";

export type ConvexDeploymentState = "deleted" | "live" | "inconclusive";

export async function probeConvexDeployment(
  callbackUrl: string,
  fetcher: typeof fetch = fetch,
): Promise<ConvexDeploymentState> {
  if (configurationCallbackDestinationError(callbackUrl)) return "inconclusive";
  const callback = new URL(callbackUrl);
  if (!/^[a-z0-9-]+\.convex\.site$/.test(callback.hostname)) return "inconclusive";
  const probeUrl = `https://${callback.hostname.replace(/\.convex\.site$/, ".convex.cloud")}/version`;
  try {
    const response = await fetcher(probeUrl, {
      redirect: "manual",
      signal: AbortSignal.timeout(5_000),
    });
    await response.body?.cancel();
    if (response.status === 200) return "live";
    if (response.status === 404 && response.headers.has("convex-usher")) return "deleted";
  } catch {
    // Provider and network failures are never evidence that a deployment was deleted.
  }
  return "inconclusive";
}
