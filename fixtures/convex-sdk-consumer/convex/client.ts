/**
 * Server-only Splitch clients for Convex actions / HTTP actions.
 *
 * Credentials live in Convex deployment environment variables
 * (https://docs.convex.dev/production/environment-variables) — never in
 * Convex client-side code. API Key must not reach the browser.
 */
import { createSplitchClient, type SplitchClient } from "@splitch/sdk";

const DEFAULT_ENDPOINT = "https://edge.splitch.dev";

function endpoint(): string {
  return process.env.SPLITCH_ENDPOINT ?? DEFAULT_ENDPOINT;
}

/** Client Key path: Exposure-bearing `evaluate` / `evaluateDetails`. */
export function createExposureClient(): SplitchClient {
  const clientKey = process.env.SPLITCH_CLIENT_KEY;
  if (clientKey === undefined || clientKey.length === 0) {
    throw new Error(
      "SPLITCH_CLIENT_KEY is not set. Store the Client Key in Convex environment variables.",
    );
  }
  return createSplitchClient({ clientKey, endpoint: endpoint() });
}

/** API Key path: non-exposing `evaluateAll` bootstrap for the browser client. */
export function createBootstrapClient(): SplitchClient {
  const apiKey = process.env.SPLITCH_API_KEY;
  if (apiKey === undefined || apiKey.length === 0) {
    throw new Error(
      "SPLITCH_API_KEY is not set. Store the API Key in Convex environment variables; never ship it to Convex client code.",
    );
  }
  return createSplitchClient({ apiKey, endpoint: endpoint() });
}
