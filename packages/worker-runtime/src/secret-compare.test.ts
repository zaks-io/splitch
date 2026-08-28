import { describe, expect, it } from "vitest";
import { timingSafeEqualString } from "./secret-compare";

describe("timingSafeEqualString", () => {
  it("accepts identical secrets", async () => {
    await expect(timingSafeEqualString("shared-secret", "shared-secret")).resolves.toBe(true);
  });

  it("rejects a different secret of the same length", async () => {
    await expect(timingSafeEqualString("shared-secret", "shared-secreX")).resolves.toBe(false);
  });

  it("rejects a missing secret without treating empty as a match", async () => {
    await expect(timingSafeEqualString("", "shared-secret")).resolves.toBe(false);
  });
});
