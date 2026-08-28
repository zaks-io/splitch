import { ConvexConfigChangedSchema } from "@splitch/sdk/local-evaluation";
import { CONVEX_WEBHOOK_MAX_BODY_BYTES, readBoundedRequestBody } from "./bounded-body";
import { constantTimeEqual, hmacHex } from "./crypto";

interface ConfigurationWebhookIntegration {
  readonly webhookSecret: string;
  readonly previousWebhookSecret?: string;
}

export interface ConfigurationWebhookDeps {
  nowSeconds(): number;
  getIntegration(): Promise<ConfigurationWebhookIntegration | null>;
  announce(args: {
    deliveryId: string;
    appId: string;
    environmentId: string;
    environmentVersion: number;
  }): Promise<void>;
}

export async function handleConfigurationWebhook(
  request: Request,
  deps: ConfigurationWebhookDeps,
): Promise<Response> {
  const bounded = await readBoundedRequestBody(request, CONVEX_WEBHOOK_MAX_BODY_BYTES);
  if (!bounded.ok) return new Response("invalid body", { status: 400 });

  const timestamp = request.headers.get("splitch-timestamp");
  const signature = request.headers.get("splitch-signature");
  if (!timestamp || !signature?.startsWith("v1="))
    return new Response("invalid signature", { status: 401 });
  const seconds = Number(timestamp);
  if (!Number.isInteger(seconds) || Math.abs(deps.nowSeconds() - seconds) > 300)
    return new Response("expired signature", { status: 401 });

  const body = bounded.text;
  const integration = await deps.getIntegration();
  if (!integration) return new Response("not installed", { status: 409 });
  const expected = await Promise.all(
    [integration.webhookSecret, integration.previousWebhookSecret]
      .filter((secret): secret is string => typeof secret === "string")
      .map((secret) => hmacHex(secret, `${timestamp}.${body}`)),
  );
  if (!expected.some((candidate) => constantTimeEqual(signature.slice(3), candidate)))
    return new Response("invalid signature", { status: 401 });
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return new Response("invalid body", { status: 400 });
  }
  const changed = ConvexConfigChangedSchema.safeParse(parsed);
  if (!changed.success) return new Response("invalid body", { status: 400 });
  if (request.headers.get("splitch-delivery-id") !== changed.data.deliveryId)
    return new Response("delivery ID mismatch", { status: 400 });
  await deps.announce({
    deliveryId: changed.data.deliveryId,
    appId: changed.data.appId,
    environmentId: changed.data.environmentId,
    environmentVersion: changed.data.environmentVersion,
  });
  return new Response(null, { status: 202 });
}
