import { configurationCallbackUrlError } from "@splitch/contracts";
import { postWebhook, type WebhookPost, type WebhookPostResult } from "./webhook-transport";

const CALLBACK_TIMEOUT_MS = 5_000;

export function configurationCallbackDestinationError(value: string): string | null {
  const shapeError = configurationCallbackUrlError(value);
  if (shapeError) return shapeError;
  const hostname = new URL(value).hostname;
  if (
    hostname === "splitch.dev" ||
    hostname.endsWith(".splitch.dev") ||
    /^splitch-control-plane-api(?:-[a-z0-9-]+)?\.[a-z0-9-]+\.workers\.dev$/.test(hostname)
  )
    return "callbackUrl must not target Splitch's own services";
  return null;
}

export async function postConfigurationCallback(request: WebhookPost): Promise<WebhookPostResult> {
  const error = configurationCallbackDestinationError(request.url);
  if (error) return { outcome: "rejected", status: 400, retryable: false };
  // Workers checks the resolved destination at connection time, including DNS rebinding.
  // Its zone-origin exception requires the explicit own-service denial above.
  // https://developers.cloudflare.com/workers/reference/security-model/
  return postWebhook({ ...request, signal: AbortSignal.timeout(CALLBACK_TIMEOUT_MS) });
}
