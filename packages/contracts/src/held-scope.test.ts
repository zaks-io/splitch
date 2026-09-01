import { describe, expect, it } from "vitest";
import {
  HeldScopeSchema,
  isCanonicalHeldScope,
  isCanonicalHeldScopes,
  MAX_HELD_SCOPE_COUNT,
  MAX_HELD_SCOPE_LENGTH,
} from "./held-scope";

describe("canonical held scopes", () => {
  it("accepts the canonical vocabulary at the collection and string bounds", () => {
    const maxLengthScope = `app:${"a".repeat(MAX_HELD_SCOPE_LENGTH - "app::member".length)}:member`;

    expect(maxLengthScope).toHaveLength(MAX_HELD_SCOPE_LENGTH);
    expect(HeldScopeSchema.parse(maxLengthScope)).toBe(maxLengthScope);
    expect(isCanonicalHeldScope(maxLengthScope)).toBe(true);
    expect(isCanonicalHeldScopes([])).toBe(true);
    expect(
      isCanonicalHeldScopes(
        Array.from({ length: MAX_HELD_SCOPE_COUNT }, () => "org:org_demo:owner"),
      ),
    ).toBe(true);
  });

  it("rejects malformed individual scope values", () => {
    expect(HeldScopeSchema.safeParse("app:app_demo:viewer").success).toBe(false);
  });

  it.each([
    ["a missing collection", undefined],
    ["a non-array collection", "app:app_demo:member"],
    ["too many scopes", Array.from({ length: MAX_HELD_SCOPE_COUNT + 1 }, () => "app:a:admin")],
    ["a non-string scope", [42]],
    ["an empty scope", [""]],
    ["an unknown scope", ["bogus"]],
    ["an empty identifier", ["app::member"]],
    ["an unknown role", ["org:org_demo:viewer"]],
    [
      "an oversized scope",
      [`org:${"a".repeat(MAX_HELD_SCOPE_LENGTH - "org::member".length + 1)}:member`],
    ],
  ])("rejects %s", (_case, scopes) => {
    expect(isCanonicalHeldScopes(scopes)).toBe(false);
  });
});
