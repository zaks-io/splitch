import { timingSafeEqualString } from "@splitch/worker-runtime";
import { postConfigurationCallback } from "./configuration-callback-transport";
import { signIntegrationPayload } from "./integration-secret";

export interface CallbackRegistration {
  installationId: string;
  callbackUrl: string;
  webhookSecret: string;
}

export type CallbackVerificationResult =
  | { ok: true }
  | { ok: false; retryable: boolean; message: string };

export async function verifyConfigurationCallback(
  registration: CallbackRegistration,
  now: Date,
  fetcher?: typeof fetch,
): Promise<CallbackVerificationResult> {
  const challenge = crypto.randomUUID();
  const body = JSON.stringify({
    type: "callback.verify",
    installationId: registration.installationId,
    challenge,
  });
  const timestamp = Math.floor(now.getTime() / 1_000).toString();
  const signature = await signIntegrationPayload(
    registration.webhookSecret,
    `${timestamp}.${body}`,
  );
  const result = await postConfigurationCallback({
    url: registration.callbackUrl,
    body,
    headers: {
      "content-type": "application/json",
      "splitch-signature": `v1=${signature}`,
      "splitch-timestamp": timestamp,
    },
    fetcher,
  });
  if (result.outcome !== "delivered")
    return {
      ok: false,
      retryable: result.outcome === "transport-failed" || result.retryable,
      message: "The configuration callback could not complete receiver verification",
    };
  const proof = result.response.headers.get("splitch-callback-proof");
  await result.response.body?.cancel();
  const expected = await signIntegrationPayload(
    registration.webhookSecret,
    `callback.verify:${registration.installationId}:${challenge}`,
  );
  if (!proof || !(await timingSafeEqualString(proof, expected)))
    return {
      ok: false,
      retryable: false,
      message: "The configuration callback did not prove possession of this installation's secret",
    };
  return { ok: true };
}
