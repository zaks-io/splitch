import { describe, expect, it } from "vitest";
import { DEVICE_CODE_GRANT, REFRESH_TOKEN_GRANT } from "./device-flow";
import { setupDoorCHarness } from "./door-c-test-harness";

const { buildApp, formPost } = setupDoorCHarness();
const secret = `spl_pat_${"a".repeat(64)}`;

describe("Personal Access Tokens are not OAuth grants", () => {
  const grants: Record<string, string>[] = [
    { grant_type: "urn:ietf:params:oauth:grant-type:token-exchange", identity_assertion: secret },
    { grant_type: DEVICE_CODE_GRANT, device_code: secret, client_id: "splitch-cli" },
    { grant_type: REFRESH_TOKEN_GRANT, refresh_token: secret, client_id: "splitch-cli" },
  ];
  it.each(grants)("refuses a PAT as $grant_type", async (body) => {
    const response = await formPost(buildApp(), "/oauth2/token", body);
    expect(response.status).toBe(400);
    const result = await response.json();
    expect(result).toMatchObject({ error: "invalid_grant" });
    expect(result).not.toHaveProperty("access_token");
    expect(JSON.stringify(result)).not.toContain("spl_pat_");
  });

  it("does not accept a PAT bearer at the token endpoint", async () => {
    const response = await buildApp().request("/oauth2/token", {
      method: "POST",
      headers: {
        authorization: `Bearer ${secret}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ client_id: "splitch-cli" }),
    });
    expect(response.status).toBe(400);
    const body = await response.text();
    expect(body).not.toContain("access_token");
    expect(body).not.toContain("spl_pat_");
  });
});
