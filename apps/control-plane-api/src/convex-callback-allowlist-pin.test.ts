import { describe, expect, it } from "vitest";
// Relative on purpose: `@splitch/convex` is published and cannot depend on the private tree, so it
// carries a second copy of this rule. A one-sided edit reintroduces SPL-601, where the component
// registered a callback the Control Plane refuses, so this test is the only thing pinning them.
// `@splitch/control-plane-api#test` lists this file's path in its turbo inputs.
import { isCanonicalCallbackUrl } from "../../../packages/convex/src/component/callback_url";
import { isConvexCallbackUrl } from "./convex-handlers";

const CANONICAL = "https://third-cat-295.convex.site/integrations/splitch/configuration";

const CANDIDATES: [label: string, value: string][] = [
  ["canonical convex.site callback", CANONICAL],
  ["root-mounted callback", "https://third-cat-295.convex.site/configuration"],
  ["custom HTTP Action domain", "https://api.mainstay.club/integrations/splitch/configuration"],
  ["canonical convex.cloud origin", "https://third-cat-295.convex.cloud/configuration"],
  ["nonstandard port", "https://third-cat-295.convex.site:8443/configuration"],
  ["path that only contains the segment", "https://third-cat-295.convex.site/configuration/other"],
  ["trailing slash", "https://third-cat-295.convex.site/configuration/"],
  ["query string", "https://third-cat-295.convex.site/configuration?target=other"],
  ["fragment", "https://third-cat-295.convex.site/configuration#other"],
  ["embedded credentials", "https://user:pass@third-cat-295.convex.site/configuration"],
  ["plaintext scheme", "http://third-cat-295.convex.site/configuration"],
  ["uppercase host", "https://THIRD-CAT-295.CONVEX.SITE/configuration"],
  ["suffix worn as a prefix", "https://evil-convex.cloud.attacker.com/configuration"],
  ["suffix worn as a label", "https://third-cat-295.convex.site.attacker.com/configuration"],
  ["lookalike apex", "https://notconvex.site/configuration"],
  ["lookalike cloud apex", "https://notconvex.cloud/configuration"],
  ["IP literal", "https://10.0.0.1/configuration"],
  ["empty", ""],
  ["malformed", "not a URL"],
  ["the string an unset variable interpolates to", "undefined"],
];

// The Control Plane predicate sits behind `callbackUrl: z.url()`, so it lets `new URL` throw where
// the component's copy returns false. Either way the value is refused; compare the admission
// decision so the table pins what reaches the allowlist, not how each side reports a refusal.
function admits(predicate: (value: string) => boolean, value: string): boolean {
  try {
    return predicate(value);
  } catch {
    return false;
  }
}

describe("Convex callback allowlist", () => {
  it.each(
    CANDIDATES,
  )("agrees with the published component predicate on the %s", (_label, value) => {
    expect(admits(isConvexCallbackUrl, value)).toBe(admits(isCanonicalCallbackUrl, value));
  });

  it("admits the canonical callback on both sides", () => {
    expect(admits(isConvexCallbackUrl, CANONICAL)).toBe(true);
    expect(admits(isCanonicalCallbackUrl, CANONICAL)).toBe(true);
  });
});
