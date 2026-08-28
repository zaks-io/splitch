import { describe, expect, it } from "vitest";
import { applyResponseHeaders } from "./security-headers";

const BASELINE = "strict-origin-when-cross-origin";

type Disclosure = "none" | "origin" | "url";
type RequestContext = "same-origin" | "cross-origin" | "downgrade";

const DISCLOSURE: Record<string, Record<RequestContext, Disclosure>> = {
  "unsafe-url": { "same-origin": "url", "cross-origin": "url", downgrade: "url" },
  "no-referrer-when-downgrade": {
    "same-origin": "url",
    "cross-origin": "url",
    downgrade: "none",
  },
  "origin-when-cross-origin": {
    "same-origin": "url",
    "cross-origin": "origin",
    downgrade: "origin",
  },
  origin: { "same-origin": "origin", "cross-origin": "origin", downgrade: "origin" },
  "strict-origin-when-cross-origin": {
    "same-origin": "url",
    "cross-origin": "origin",
    downgrade: "none",
  },
  "strict-origin": {
    "same-origin": "origin",
    "cross-origin": "origin",
    downgrade: "none",
  },
  "same-origin": { "same-origin": "url", "cross-origin": "none", downgrade: "none" },
  "no-referrer": { "same-origin": "none", "cross-origin": "none", downgrade: "none" },
};

function mergedPolicy(current: string): string | null {
  return applyResponseHeaders(new Response("ok", { headers: { "referrer-policy": current } }), {
    "referrer-policy": BASELINE,
  }).headers.get("referrer-policy");
}

describe("Referrer-Policy request-context partial order", () => {
  it.each([
    ["unsafe-url", BASELINE],
    ["no-referrer-when-downgrade", BASELINE],
    ["origin-when-cross-origin", BASELINE],
    ["origin", "origin"],
    ["strict-origin-when-cross-origin", BASELINE],
    ["strict-origin", "strict-origin"],
    ["same-origin", "same-origin"],
    ["no-referrer", "no-referrer"],
  ])("merges %s to %s", (current, expected) => {
    expect(mergedPolicy(current)).toBe(expected);
  });

  it("keeps origin because it and the baseline are incomparable", () => {
    const origin = DISCLOSURE.origin;
    if (!origin) throw new Error("origin matrix is missing");
    expect(origin["same-origin"]).toBe("origin");
    expect(DISCLOSURE[BASELINE]?.["same-origin"]).toBe("url");
    expect(origin.downgrade).toBe("origin");
    expect(DISCLOSURE[BASELINE]?.downgrade).toBe("none");
    expect(mergedPolicy("origin")).toBe("origin");
  });

  it("never selects a policy that reveals more in any request context", () => {
    const rank: Record<Disclosure, number> = { none: 0, origin: 1, url: 2 };
    const contexts: RequestContext[] = ["same-origin", "cross-origin", "downgrade"];

    for (const current of Object.keys(DISCLOSURE)) {
      const selected = mergedPolicy(current);
      expect(selected).not.toBeNull();
      const selectedDisclosure = DISCLOSURE[selected ?? ""];
      const currentDisclosure = DISCLOSURE[current];
      expect(selectedDisclosure).toBeDefined();
      expect(currentDisclosure).toBeDefined();
      for (const context of contexts) {
        expect(rank[selectedDisclosure?.[context] ?? "url"]).toBeLessThanOrEqual(
          rank[currentDisclosure?.[context] ?? "none"],
        );
      }
    }
  });

  it("keeps an effective no-referrer policy list", () => {
    expect(mergedPolicy("unsafe-url, no-referrer")).toBe("unsafe-url, no-referrer");
  });
});
