import type { InferRequestType } from "hono/client";
import { createExperimentsHcClient, createFlagsHcClient } from "./hc-client";

/**
 * Compile-time checks: `hc` infers nested route paths and request shapes from the
 * emit-only contract apps. These `@ts-expect-error` lines are enforced by `tsc`.
 */
function hcInferenceChecks() {
  const flagsClient = createFlagsHcClient({ baseUrl: "https://control-plane.test" });
  const experimentsClient = createExperimentsHcClient({ baseUrl: "https://control-plane.test" });

  type FlagsListArgs = InferRequestType<(typeof flagsClient.apps)[":appId"]["flags"]["$get"]>;
  type _FlagsListRequiresAppId = FlagsListArgs extends { param: { appId: string } } ? true : false;
  const _flagsList: _FlagsListRequiresAppId = true;

  type ExperimentsListArgs = InferRequestType<
    (typeof experimentsClient.apps)[":appId"]["envs"][":environmentId"]["experiments"]["$get"]
  >;
  type _ExperimentsListRequiresEnv = ExperimentsListArgs extends {
    param: { appId: string; environmentId: string };
  }
    ? true
    : false;
  const _experimentsList: _ExperimentsListRequiresEnv = true;

  void flagsClient.apps[":appId"].flags.$get;
  // @ts-expect-error flags_list requires appId param from hc inference
  void flagsClient.apps[":appId"].flags.$get({});

  void experimentsClient.apps[":appId"].envs[":environmentId"].experiments.$get;
  void experimentsClient.apps[":appId"].envs[":environmentId"].experiments.$get({
    // @ts-expect-error experiments_list requires environmentId from hc inference
    param: { appId: "app_local" },
  });
}

void hcInferenceChecks;
