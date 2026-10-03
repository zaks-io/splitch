import { describe, expect, it } from "vitest";
import { flagRemovalSdkCallShapes } from "./flag-removal-sdk-shapes";

describe("flagRemovalSdkCallShapes", () => {
  it("embeds the Flag key in real packages/sdk accessor names", () => {
    expect(flagRemovalSdkCallShapes("new-checkout")).toEqual([
      'evaluate("new-checkout"',
      'evaluateDetails("new-checkout"',
      'peekVariant("new-checkout"',
      'verify("new-checkout"',
      'useFlag("new-checkout"',
      'useFlagDetails("new-checkout"',
      'resolveBooleanEvaluation("new-checkout"',
      'resolveStringEvaluation("new-checkout"',
      'resolveNumberEvaluation("new-checkout"',
      'resolveObjectEvaluation("new-checkout"',
    ]);
  });

  it("fails loud on an empty Flag key", () => {
    expect(() => flagRemovalSdkCallShapes("")).toThrow(/non-empty/);
  });
});
