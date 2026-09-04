import { describe, expect, it } from "vitest";
// Relative on purpose: `@splitch/convex` is published and cannot depend on the private tree, so it
// carries a second copy of this rule. A one-sided edit reintroduces SPL-601, where the component
// registered a callback the Control Plane refuses, so this test is the only thing pinning them.
// `@splitch/control-plane-api#test` lists this file's path in its turbo inputs.
import { isCanonicalCallbackUrl } from "../../../packages/convex/src/component/callback_url";
import { isConvexCallbackUrl } from "./convex-handlers";

const CANONICAL = "https://third-cat-295.convex.site/integrations/splitch/configuration";

// Each row carries the verdict both copies must reach. Asserting the verdict rather than only
// asserting that the two agree is what makes a lockstep edit to both copies fail: agreement alone
// still holds when the same guard is deleted from each side.
const CANDIDATES: [label: string, value: string, admitted: boolean][] = [
  ["canonical convex.site callback", CANONICAL, true],
  ["root-mounted callback", "https://third-cat-295.convex.site/configuration", true],
  ["deeper subdomain", "https://a.b.third-cat-295.convex.site/configuration", true],
  [
    "custom HTTP Action domain",
    "https://hooks.mainstay.club/integrations/splitch/configuration",
    false,
  ],
  ["canonical convex.cloud origin", "https://third-cat-295.convex.cloud/configuration", false],
  ["nonstandard port", "https://third-cat-295.convex.site:8443/configuration", false],
  [
    "path that only contains the segment",
    "https://third-cat-295.convex.site/configuration/o",
    false,
  ],
  ["trailing slash", "https://third-cat-295.convex.site/configuration/", false],
  ["query string", "https://third-cat-295.convex.site/configuration?target=other", false],
  ["fragment", "https://third-cat-295.convex.site/configuration#other", false],
  ["username only", "https://user@third-cat-295.convex.site/configuration", false],
  ["password only", "https://:pass@third-cat-295.convex.site/configuration", false],
  ["username and password", "https://user:pass@third-cat-295.convex.site/configuration", false],
  [
    "credentials wearing the host as a userinfo",
    "https://x.convex.site@evil.com/configuration",
    false,
  ],
  ["empty deployment label", "https://.convex.site/configuration", false],
  ["empty label before the suffix", "https://..convex.site/configuration", false],
  ["empty inner label", "https://third-cat-295..convex.site/configuration", false],
  ["plaintext scheme", "http://third-cat-295.convex.site/configuration", false],
  ["uppercase host", "https://THIRD-CAT-295.CONVEX.SITE/configuration", true],
  ["suffix worn as a prefix", "https://evil-convex.cloud.attacker.com/configuration", false],
  ["suffix worn as a label", "https://third-cat-295.convex.site.attacker.com/configuration", false],
  ["lookalike apex", "https://notconvex.site/configuration", false],
  ["lookalike cloud apex", "https://notconvex.cloud/configuration", false],
  ["IP literal", "https://10.0.0.1/configuration", false],
  ["opaque origin", "data:text/plain,configuration", false],
  ["empty", "", false],
  ["malformed", "not a URL", false],
  ["the string an unset variable interpolates to", "undefined", false],
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
  it.each(CANDIDATES)("reaches the same verdict on the %s", (_label, value, admitted) => {
    expect(admits(isConvexCallbackUrl, value)).toBe(admitted);
    expect(admits(isCanonicalCallbackUrl, value)).toBe(admitted);
  });

  it("admits something, so a predicate that refuses everything cannot pass the table", () => {
    expect(CANDIDATES.some(([, , admitted]) => admitted)).toBe(true);
  });
});
