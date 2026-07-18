import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ProvisionalOrgBanner } from "./provisional-org-banner";

describe("ProvisionalOrgBanner", () => {
  it("is persistent, includes the expiry, and links into the claim ceremony", () => {
    const html = renderToStaticMarkup(
      <ProvisionalOrgBanner claimHref="/demo/claim" demoExpiresAt="2026-07-18T12:00:00.000Z" />,
    );

    expect(html).toContain('data-testid="provisional-org-banner"');
    expect(html).toContain("Claim it to keep your work.");
    expect(html).toContain('href="/demo/claim"');
  });
});
