import { PERSONAL_ACCESS_TOKEN_STEP_UP_CHALLENGE } from "@splitch/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  broadGrant,
  readGrant,
  stepUpFixture,
  USER,
} from "./personal-access-token-step-up-fixture";

let f: Awaited<ReturnType<typeof stepUpFixture>>;
beforeEach(async () => {
  f = await stepUpFixture();
});
afterEach(async () => {
  await f.bindings.dispose();
});

describe("PAT challenge response through real D1", () => {
  it("keeps the released CLI's 403 FORBIDDEN body and human message unchanged", async () => {
    const response = await f.call("POST", "/personal-access-tokens", {
      name: "broad",
      grants: [broadGrant],
    });
    expect(response.status).toBe(403);
    expect(response.headers.get("WWW-Authenticate")).toBe(PERSONAL_ACCESS_TOKEN_STEP_UP_CHALLENGE);
    expect(await response.json()).toEqual({
      code: "FORBIDDEN",
      outcome: "user_action_required",
      message:
        "all-memberships authority requires fresh approval; rerun the same splitch tokens command to approve in the browser",
      details: {},
    });
    expect(await f.repo.personalAccessTokens.listActiveForUser(USER)).toEqual([]);
    expect(f.puts).toEqual([]);
  });

  it.each(["validation", "membership", "not found", "door", "expired rotation", "unauthenticated"])(
    "does not challenge a %s refusal",
    async (kind) => {
      let response: Response;
      let expected: [number, string];
      if (kind === "not found") {
        response = await f.call("PATCH", `/personal-access-tokens/pat_${"0".repeat(32)}`, {
          name: "x",
        });
        expected = [404, "CREDENTIAL_NOT_FOUND"];
      } else if (kind === "expired rotation") {
        const { row } = await f.seed([readGrant], new Date(f.now() - 1000).toISOString());
        response = await f.call("POST", `/personal-access-tokens/${row.id}/rotate`);
        expected = [403, "FORBIDDEN"];
      } else if (kind === "unauthenticated") {
        response = await f.app().request("/personal-access-tokens", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "x", grants: [readGrant] }),
        });
        expected = [401, "UNAUTHORIZED"];
      } else {
        response = await f.call(
          "POST",
          "/personal-access-tokens",
          {
            name: "x",
            grants: kind === "membership" ? [{ ...readGrant, target: "app:missing" }] : [readGrant],
            ...(kind === "validation" ? { expiresAt: "invalid" } : {}),
          },
          kind === "door" ? { claims: { auth_door: "id_jag" } } : {},
        );
        expected = kind === "door" ? [403, "FORBIDDEN"] : [400, "VALIDATION_ERROR"];
      }
      expect(response.status).toBe(expected[0]);
      expect(((await response.json()) as { code: string }).code).toBe(expected[1]);
      expect(response.headers.has("WWW-Authenticate")).toBe(false);
      expect(f.puts).toEqual([]);
    },
  );
});
