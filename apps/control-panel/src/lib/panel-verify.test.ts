import type { ResolutionDetails } from "@splitch/contracts";
import { describe, expect, it, vi } from "vitest";
import { explainVerifyResult, panelVerifyOutcome, verifyFlagWithClientKey } from "./panel-verify";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("verifyFlagWithClientKey", () => {
  it("calls the data plane verify route with the Client Key as a bearer token", async () => {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    const fakeFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return jsonResponse({ value: true, variantName: "treatment", reason: "SPLIT" });
    });

    const details = await verifyFlagWithClientKey({
      clientKey: "ck_live_abc",
      endpoint: "https://edge.example.test",
      flagKey: "new-checkout",
      targetingKey: "user-1",
      fetch: fakeFetch as unknown as typeof fetch,
    });

    expect(details).toEqual({ value: true, variantName: "treatment", reason: "SPLIT" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://edge.example.test/api/sdk/verify");
    const headers = new Headers(calls[0]?.init?.headers);
    expect(headers.get("authorization")).toBe("Bearer ck_live_abc");
    expect(JSON.parse(String(calls[0]?.init?.body))).toMatchObject({
      flagKey: "new-checkout",
      targetingKey: "user-1",
    });
  });

  it("sends no idempotency key, because verify is not a billable Evaluation", async () => {
    const seen: RequestInit[] = [];
    const fakeFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init) seen.push(init);
      return jsonResponse({ value: false, variantName: "control", reason: "DEFAULT" });
    });

    await verifyFlagWithClientKey({
      clientKey: "ck",
      endpoint: "https://edge.example.test",
      flagKey: "f",
      targetingKey: "u",
      fetch: fakeFetch as unknown as typeof fetch,
    });

    const body = JSON.parse(String(seen[0]?.body)) as Record<string, unknown>;
    expect(body).not.toHaveProperty("idempotencyKey");
    expect(new Headers(seen[0]?.headers).get("idempotency-key")).toBeNull();
  });

  it("fails loud when the Evaluation API is unreachable", async () => {
    const details = await verifyFlagWithClientKey({
      clientKey: "ck",
      endpoint: "https://edge.example.test",
      flagKey: "f",
      targetingKey: "u",
      fetch: (async () => {
        throw new TypeError("fetch failed");
      }) as unknown as typeof fetch,
    });

    expect(details.reason).toBe("ERROR");
    expect(explainVerifyResult(panelVerifyOutcome(details)).tone).toBe("failed");
  });
});

describe("explainVerifyResult", () => {
  it("renders the Variant value as JSON text so objects survive the wire", () => {
    expect(
      panelVerifyOutcome({ value: { tier: "gold" }, variantName: "a", reason: "SPLIT" }),
    ).toMatchObject({ valueJson: '{"tier":"gold"}', ruleId: null, errorCode: null });
  });

  it("names the resolved Variant on success", () => {
    const explanation = explainVerifyResult(
      panelVerifyOutcome({ value: true, variantName: "treatment", reason: "SPLIT" }),
    );
    expect(explanation.tone).toBe("resolved");
    expect(explanation.headline).toBe("Resolved to treatment");
    expect(explanation.detail).toContain("slice of the split");
  });

  it("never lets an ERROR read as a resolution", () => {
    const explanation = explainVerifyResult(
      panelVerifyOutcome({
        value: false,
        variantName: null,
        reason: "ERROR",
        errorCode: "UNAUTHORIZED",
        errorMessage: "client key revoked",
      }),
    );

    expect(explanation.tone).toBe("failed");
    expect(explanation.headline).toBe("Verify failed");
    expect(explanation.headline).not.toContain("Resolved");
    expect(explanation.detail).toContain("UNAUTHORIZED");
    expect(explanation.detail).toContain("not an answer from your Flag");
  });

  it("explains the reason for every value in the contract", () => {
    for (const reason of ["SPLIT", "TARGETING_MATCH", "DEFAULT", "DISABLED", "CACHED", "STALE"]) {
      const explanation = explainVerifyResult(
        panelVerifyOutcome({
          value: true,
          variantName: "treatment",
          reason,
          ...(reason === "TARGETING_MATCH" ? { ruleId: "rule-1" } : {}),
        } as ResolutionDetails),
      );
      expect(explanation.tone).toBe("resolved");
      expect(explanation.detail.length).toBeGreaterThan(0);
    }
  });
});
