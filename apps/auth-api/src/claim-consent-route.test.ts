import { describe, expect, it } from "vitest";
import type { ClaimDeps } from "./claim";
import { handleConsent } from "./claim-consent-route";

describe("claim consent body parsing", () => {
  it("returns malformed consent decision for invalid JSON, not missing", async () => {
    const response = await postConsent("}{");

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "invalid_request",
      error_description: "malformed consent decision",
    });
  });

  it("returns missing consent decision for an empty JSON body", async () => {
    const response = await postConsent("");

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "invalid_request",
      error_description: "missing consent decision",
    });
  });
});

function postConsent(body: string): Promise<Response> {
  return handleConsent(
    {
      claim: {} as ClaimDeps,
      workosAccessTokens: { verify: async () => ({ userId: "user-1" }) },
    },
    new Request("https://auth.splitch.test/claim/consent/attempt-1", {
      method: "POST",
      headers: {
        authorization: "Bearer workos-token",
        "content-type": "application/json",
      },
      body,
    }),
    "attempt-1",
    () => 1_780_000_000,
  );
}
