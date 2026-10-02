import { describe, expect, it, vi } from "vitest";
import { SplitchOfrepProvider } from "./provider";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("SplitchOfrepProvider", () => {
  it("rejects an invalid baseUrl at construction", () => {
    expect(() => new SplitchOfrepProvider({ baseUrl: "not-a-url", credential: "pk_x" })).toThrow(
      /valid URL/,
    );
  });

  it("resolves a boolean Flag from the OFREP single-flag endpoint", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, { key: "new-checkout", value: true, reason: "SPLIT", variant: "on" }),
    );
    const provider = new SplitchOfrepProvider({
      baseUrl: "https://edge.example",
      credential: "pk_test",
      fetch: fetchImpl as unknown as typeof fetch,
    });

    const details = await provider.resolveBooleanEvaluation("new-checkout", false, {
      targetingKey: "user-1",
      plan: "pro",
    });

    expect(details).toEqual({ value: true, variant: "on", reason: "SPLIT" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [, init] = fetchImpl.mock.calls[0] as [URL, RequestInit];
    expect(new URL(String(fetchImpl.mock.calls[0]?.[0])).pathname).toBe(
      "/ofrep/v1/evaluate/flags/new-checkout",
    );
    expect(init.headers).toMatchObject({ authorization: "Bearer pk_test" });
    expect(JSON.parse(String(init.body))).toEqual({
      context: { targetingKey: "user-1", plan: "pro" },
    });
  });

  it("returns the code default when OFREP omits value", async () => {
    const provider = new SplitchOfrepProvider({
      baseUrl: "https://edge.example",
      credential: "sk_test",
      fetch: (async () => jsonResponse(200, { key: "theme", reason: "STATIC" })) as typeof fetch,
    });

    await expect(
      provider.resolveStringEvaluation("theme", "light", { targetingKey: "user-1" }),
    ).resolves.toMatchObject({ value: "light", reason: "STATIC" });
  });

  it("maps FLAG_NOT_FOUND to an error ResolutionDetails with the default value", async () => {
    const provider = new SplitchOfrepProvider({
      baseUrl: "https://edge.example",
      credential: "pk_test",
      fetch: (async () =>
        jsonResponse(404, {
          key: "missing",
          errorCode: "FLAG_NOT_FOUND",
          errorDetails: "Flag 'missing' was not found",
        })) as typeof fetch,
    });

    await expect(
      provider.resolveBooleanEvaluation("missing", false, { targetingKey: "user-1" }),
    ).resolves.toEqual({
      value: false,
      reason: "ERROR",
      errorCode: "FLAG_NOT_FOUND",
      errorMessage: "Flag 'missing' was not found",
    });
  });

  it("fails loud on a type mismatch instead of coercing the value", async () => {
    const provider = new SplitchOfrepProvider({
      baseUrl: "https://edge.example",
      credential: "pk_test",
      fetch: (async () =>
        jsonResponse(200, { key: "size", value: "large", reason: "STATIC" })) as typeof fetch,
    });

    await expect(
      provider.resolveNumberEvaluation("size", 1, { targetingKey: "user-1" }),
    ).resolves.toMatchObject({
      value: 1,
      reason: "ERROR",
      errorCode: "TYPE_MISMATCH",
    });
  });
});
