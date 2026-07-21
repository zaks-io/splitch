import { scopedAnalysisResultsRequest } from "@splitch/control-plane-sdk/panel-experiments";
import { describe, expect, it } from "vitest";
import { scopedIdentityForRequest } from "./scoped-service-identity";

const identity = {
  operation: "experiment_results_post" as const,
  actorId: "user_1",
  appId: "app_1",
  environmentId: "env_1",
  experimentId: "exp_1",
  runId: "run_1",
};

describe("binding-only scoped Analysis identity", () => {
  it("accepts only an exact resource and Run match", async () => {
    expect(await scopedIdentityForRequest(scopedAnalysisResultsRequest(identity))).toEqual(
      identity,
    );

    const wrongRun = scopedAnalysisResultsRequest(identity);
    expect(
      await scopedIdentityForRequest(
        new Request(wrongRun, { body: JSON.stringify({ runId: "run_other" }) }),
      ),
    ).toBeNull();

    const wrongPath = scopedAnalysisResultsRequest(identity);
    expect(
      await scopedIdentityForRequest(
        new Request(wrongPath.url.replace("/exp_1/", "/exp_other/"), wrongPath),
      ),
    ).toBeNull();
  });

  it("rejects any other method or malformed identity", async () => {
    const request = scopedAnalysisResultsRequest(identity);
    expect(
      await scopedIdentityForRequest(
        new Request(request.url, { method: "GET", headers: request.headers }),
      ),
    ).toBeNull();
    expect(
      await scopedIdentityForRequest(
        new Request(request, {
          headers: { "x-splitch-scoped-service-identity": "{}" },
        }),
      ),
    ).toBeNull();
  });
});
