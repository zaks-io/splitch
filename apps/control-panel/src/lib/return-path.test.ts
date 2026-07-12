import { describe, expect, it } from "vitest";
import { safeReturnPath } from "./return-path";

const REQUEST_URL = "https://panel.example.test/auth/login";

describe("safeReturnPath", () => {
  it("returns the root for an empty candidate", () => {
    expect(safeReturnPath(null, REQUEST_URL)).toBe("/");
    expect(safeReturnPath("", REQUEST_URL)).toBe("/");
  });

  it("passes through a same-origin in-app path", () => {
    expect(safeReturnPath("/acme/checkout/prod", REQUEST_URL)).toBe("/acme/checkout/prod");
    expect(safeReturnPath("/flags?tab=live#top", REQUEST_URL)).toBe("/flags?tab=live#top");
  });

  it("rejects a protocol-relative path", () => {
    expect(safeReturnPath("//evil.com", REQUEST_URL)).toBe("/");
  });

  it("rejects backslash open-redirect variants", () => {
    // Browsers normalize `\` to `/` for special schemes, so these resolve to a
    // foreign origin despite starting with a single `/`.
    expect(safeReturnPath("/\\evil.com", REQUEST_URL)).toBe("/");
    expect(safeReturnPath("/\\/evil.com", REQUEST_URL)).toBe("/");
    expect(safeReturnPath("/path\\to", REQUEST_URL)).toBe("/");
  });

  it("rejects a cross-origin absolute URL", () => {
    expect(safeReturnPath("https://evil.com/x", REQUEST_URL)).toBe("/");
  });

  it("keeps the path of a same-origin absolute URL", () => {
    expect(safeReturnPath("https://panel.example.test/dashboard", REQUEST_URL)).toBe("/dashboard");
  });

  it("never returns an auth path", () => {
    expect(safeReturnPath("/auth/login", REQUEST_URL)).toBe("/");
    expect(safeReturnPath("/auth/callback", REQUEST_URL)).toBe("/");
    expect(safeReturnPath("/auth/logout", REQUEST_URL)).toBe("/");
  });
});
