import { expect, test } from "./fixtures";

/**
 * Personal Access Token round trip against the hosted stack: a Control Plane
 * session mints a read-only PAT, the PAT reads through MCP, a mutation is
 * refused as read-only, and a revoked PAT is refused on its next use.
 */
test.describe("shared-preview Personal Access Token", () => {
  test("a read-only PAT reads over MCP, cannot write, and stops working once revoked", async ({
    controlPlaneAccessToken,
    smoke,
  }) => {
    const created = await smoke.controlPlaneSend<{ token: { id: string }; secret: string }>(
      controlPlaneAccessToken,
      "POST",
      "/personal-access-tokens",
      {
        name: smoke.uniqueKey("pat-smoke"),
        grants: [{ target: `app:${smoke.config.smokeAppId}`, role: "member", access: "read" }],
        expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      },
    );
    const pat = created.secret;
    try {
      expect(/^spl_pat_[0-9a-f]{64}$/.test(pat), "created PAT secret is valid").toBe(true);
      const app = await smoke.callTool<Record<string, unknown>>(pat, "apps_get", {
        appId: smoke.config.smokeAppId,
      });
      expect(app).toMatchObject({ id: smoke.config.smokeAppId });

      const refused = await smoke.callToolExpectError<Record<string, unknown>>(pat, "apps_update", {
        appId: smoke.config.smokeAppId,
        name: "must not be renamed by a read-only PAT",
      });
      expect(JSON.stringify(refused)).toContain("read-only access");
    } finally {
      await smoke.controlPlaneSend(
        controlPlaneAccessToken,
        "POST",
        `/personal-access-tokens/${created.token.id}/revoke`,
      );
    }

    // D1 is authoritative at the Control Plane, so the refusal is immediate even
    // before the MCP Worker's KV entry converges: either the transport rejects
    // the secret (401) or the delegated call is refused as revoked.
    const response = await smoke.callToolRaw(pat, "apps_get", { appId: smoke.config.smokeAppId });
    if (response.status === 401) {
      expect(response.headers.get("www-authenticate")).toContain('error="invalid_token"');
    } else {
      expect(JSON.stringify(await response.json())).toContain("CREDENTIAL_REVOKED");
    }
  });
});
