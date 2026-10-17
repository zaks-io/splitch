import type { Repository } from "@splitch/db";
import type { Principal } from "@splitch/worker-runtime";
import { makeTestApp } from "./test-app-fixture";

/** Supply a real Analysis service-binding fetch to reuse this route-stack harness. */
export function makeAppAuditReadHarness(input: {
  repo: Repository;
  principal: Principal;
  analysis: Pick<Fetcher, "fetch">;
}) {
  return makeTestApp({
    repo: input.repo,
    authResolver: () => ({ ok: true, principal: input.principal }),
    delegationBindings: { "analysis-api": input.analysis as Fetcher },
  });
}
