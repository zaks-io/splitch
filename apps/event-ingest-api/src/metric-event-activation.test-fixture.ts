import { CURRENT_KV_SCHEMA_VERSION } from "@splitch/contracts";

/** The Activation config blob resolution reads, and the failure it reports. */

export function activationConfig(
  bindings: readonly Record<string, unknown>[] = [
    {
      eventDefinitionId: "ed_signed_up",
      experimentId: "exp_signup",
      runId: "run_signup",
      idType: "user",
    },
  ],
): string {
  return JSON.stringify({ schemaVersion: CURRENT_KV_SCHEMA_VERSION, data: { bindings } });
}

export async function errorMessage(response: Response): Promise<string> {
  const body = (await response.json()) as { message?: unknown };
  return String(body.message);
}
