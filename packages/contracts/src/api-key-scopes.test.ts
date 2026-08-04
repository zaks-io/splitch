import { describe, expect, it } from "vitest";
import { ApiKeyScopeSchema, apiKeyScopes } from "./api-key-scopes";
import { CreateApiKeyRequestSchema } from "./routes/route-shapes";

describe("apiKeyScopes vocabulary", () => {
  it("accepts every canonical scope", () => {
    for (const scope of apiKeyScopes) {
      expect(ApiKeyScopeSchema.parse(scope)).toBe(scope);
    }
  });

  it("rejects an unknown scope and names the allowed set", () => {
    const result = ApiKeyScopeSchema.safeParse("bogus");
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues[0]?.message).toBe(`allowed scopes: ${apiKeyScopes.join(", ")}`);
  });
});

describe("CreateApiKeyRequestSchema scope guard", () => {
  it("accepts a valid scope set", () => {
    expect(
      CreateApiKeyRequestSchema.parse({
        scopes: ["data-plane:evaluate", "data-plane:write"],
      }),
    ).toEqual({
      scopes: ["data-plane:evaluate", "data-plane:write"],
    });
  });

  it("rejects an unknown scope with the allowed set in the issue message", () => {
    const result = CreateApiKeyRequestSchema.safeParse({ scopes: ["bogus"] });
    expect(result.success).toBe(false);
    if (result.success) return;
    const issue = result.error.issues[0];
    expect(issue?.path).toEqual(["scopes", 0]);
    expect(issue?.message).toBe(`allowed scopes: ${apiKeyScopes.join(", ")}`);
  });
});
