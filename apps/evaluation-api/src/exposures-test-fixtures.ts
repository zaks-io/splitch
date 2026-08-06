import { StaticSaltStore } from "./assignment/assignment-store-test-fixtures";
import { mintExposureTicket } from "./evaluate/exposure-ticket";
import { APP_ID, ENVIRONMENT_ID, EXPERIMENT_ID, FLAG_KEY } from "./sdk-route-test-fixtures";

export const PATH = "/api/sdk/exposures";
export const APP_B = "app-B";
export const CLIENT_KEY_B = "pk_exposures_app_b";
// Split so secret scanners do not treat the fixture as a live credential.
const TICKET_KEY = ["splitch-test-exposure-ticket-key", "32chars"].join("-");
export const PREVIOUS_TICKET_KEY = ["splitch-test-previous-ticket-key", "32ch"].join("-");

export const EXPOSURE_ID_A = "550e8400-e29b-41d4-a716-446655440001";
export const EXPOSURE_ID_B = "550e8400-e29b-41d4-a716-446655440002";

export async function mintTicket(
  overrides: Partial<{
    appId: string;
    environmentId: string;
    variant: string;
    targetingKey: string;
    issuedAt: string;
    ticketKey: string;
  }> = {},
): Promise<string> {
  return mintExposureTicket(
    {
      appId: overrides.appId ?? APP_ID,
      environmentId: overrides.environmentId ?? ENVIRONMENT_ID,
      experimentId: EXPERIMENT_ID,
      flagKey: FLAG_KEY,
      idType: "user",
      liveRunId: "run-42",
      targetingKey: overrides.targetingKey ?? "user-1",
      variant: overrides.variant ?? "treatment",
    },
    {
      saltStore: new StaticSaltStore(),
      ticketKey: overrides.ticketKey ?? TICKET_KEY,
      now: () => new Date(overrides.issuedAt ?? "2026-07-03T00:00:00.000Z"),
    },
  );
}

export function exposuresInit(
  credential: string | undefined,
  exposures: Array<{
    exposureId: string;
    exposureTicket: string;
    clientTimestamp?: string;
  }>,
  extraHeaders: Record<string, string> = {},
): RequestInit {
  return {
    method: "POST",
    headers: {
      ...(credential === undefined ? {} : { authorization: `Bearer ${credential}` }),
      "content-type": "application/json",
      ...extraHeaders,
    },
    body: JSON.stringify({
      exposures: exposures.map((item) => ({
        exposureId: item.exposureId,
        exposureTicket: item.exposureTicket,
        clientTimestamp: item.clientTimestamp ?? "2026-07-03T00:00:01.000Z",
      })),
    }),
  };
}
