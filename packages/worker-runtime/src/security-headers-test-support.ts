import { expect } from "vitest";

export function expectBaseline(response: Response): void {
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(response.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
}

/**
 * Browser CSP policy-list + first-directive-wins. Independent of production
 * serialization so the exact-header regression cannot pass by echoing text.
 */
export function cspAllowsFraming(header: string): boolean {
  let allowed: "all" | "none" | Set<string> = "all";
  for (const policyText of header.split(",")) {
    const policyAllowed = policyFrameAncestors(policyText);
    if (!policyAllowed) continue;
    allowed = intersectAllowedAncestors(allowed, policyAllowed);
  }
  return allowed !== "none";
}

export function cspHasDuplicateFrameAncestors(header: string): boolean {
  return header.split(",").some((policyText) => {
    const count = policyText
      .split(";")
      .filter((part) => part.trim().toLowerCase().startsWith("frame-ancestors")).length;
    return count > 1;
  });
}

function policyFrameAncestors(policyText: string): "none" | Set<string> | undefined {
  const frameAncestors = firstPolicyDirectives(policyText).get("frame-ancestors");
  if (frameAncestors === undefined) return undefined;
  const sources = frameAncestors.toLowerCase().split(/\s+/).filter(Boolean);
  return sources.length === 0 || sources.includes("'none'") ? "none" : new Set(sources);
}

function firstPolicyDirectives(policyText: string): Map<string, string> {
  const directives = new Map<string, string>();
  for (const part of policyText.split(";")) {
    const parsed = parseDirectivePart(part);
    if (parsed && !directives.has(parsed.name)) directives.set(parsed.name, parsed.value);
  }
  return directives;
}

function parseDirectivePart(part: string): { name: string; value: string } | undefined {
  const trimmed = part.trim();
  if (!trimmed) return undefined;
  const space = trimmed.search(/\s/);
  if (space === -1) return { name: trimmed.toLowerCase(), value: "" };
  return { name: trimmed.slice(0, space).toLowerCase(), value: trimmed.slice(space).trim() };
}

function intersectAllowedAncestors(
  left: "all" | "none" | Set<string>,
  right: "none" | Set<string>,
): "all" | "none" | Set<string> {
  if (left === "all") return right;
  if (left === "none" || right === "none") return "none";
  const intersection = [...left].filter((source) => right.has(source));
  return intersection.length === 0 ? "none" : new Set(intersection);
}
