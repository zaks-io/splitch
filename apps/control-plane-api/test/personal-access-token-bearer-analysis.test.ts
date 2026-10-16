import { env } from "cloudflare:workers";
import { DELEGATED_IDENTITY_HEADER } from "@splitch/worker-runtime";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { seedAppMember } from "../src/test-seeds";
import { OWNER, recordingBinding, TENANT_A, TENANT_B } from "./index-mcp-fixtures";
import { bearerFixture, repo, SECRET, TOKEN_ID } from "./personal-access-token-bearer-fixture";

const requests: Request[] = [];
let fixture: Awaited<ReturnType<typeof bearerFixture>>;
const results = {
  state: "no_data",
  run_id: TENANT_A.runId,
  control_variant: "control",
  missing: "metric_events",
};

beforeAll(async () => {
  fixture = await bearerFixture({ ANALYSIS_API: recordingBinding(requests, results) });
  // Membership on both Apps makes the configured grant the cross-App boundary.
  await seedAppMember(env.DB, { appId: TENANT_B.appId, userId: OWNER, role: "owner" });
  await env.DB.prepare("UPDATE experiments SET default_variant_id = ? WHERE app_id = ?")
    .bind(`${TENANT_A.flagId}_control`, TENANT_A.appId)
    .run();
});
beforeEach(async () => {
  await env.DB.prepare("DELETE FROM personal_access_tokens").run();
  await fixture.seed([{ target: `app:${TENANT_A.appId}`, role: "member", permissions: [] }]);
  fixture.resetLimits();
  requests.length = 0;
});

function resultsPath(tenant: typeof TENANT_A) {
  return `/apps/${tenant.appId}/envs/${tenant.environmentId}/experiments/${tenant.experimentId}/results`;
}

describe("public PAT Analysis delegation", () => {
  it("forwards only narrowed read authority and refuses a cross-App request before the hop", async () => {
    const response = await fixture.call("POST", resultsPath(TENANT_A), {});
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await response.json()).toMatchObject(results);
    expect(requests).toHaveLength(1);
    const forwarded = requests[0];
    if (!forwarded) throw new Error("Analysis request missing");
    expect(JSON.parse(forwarded.headers.get(DELEGATED_IDENTITY_HEADER) ?? "null")).toMatchObject({
      operation: "experiment_results_post",
      actorId: OWNER,
      appId: TENANT_A.appId,
      scopes: [`app:${TENANT_A.appId}:member`],
    });
    expect(forwarded.headers.has("authorization")).toBe(false);
    const forwardedContent = JSON.stringify([...forwarded.headers]) + (await forwarded.text());
    expect(forwardedContent.includes(SECRET)).toBe(false);
    expect(forwardedContent.includes("spl_pat_")).toBe(false);

    const denied = await fixture.call("POST", resultsPath(TENANT_B), {});
    expect(denied.status).toBe(403);
    expect(requests).toHaveLength(1);
  });

  it("applies grant narrowing before the next delegated read", async () => {
    await repo().personalAccessTokens.update(OWNER, TOKEN_ID, {
      grants: JSON.stringify([
        { target: `app:${TENANT_B.appId}`, role: "member", permissions: [] },
      ]),
    });
    expect((await fixture.call("POST", resultsPath(TENANT_A), {})).status).toBe(403);
    expect(requests).toHaveLength(0);
  });
});
