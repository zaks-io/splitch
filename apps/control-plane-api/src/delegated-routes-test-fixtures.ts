import type { Repository } from "@splitch/db";
import type { AuthResolver, RateLimiter } from "@splitch/worker-runtime";
import { vi } from "vitest";
import type { DelegationBindings } from "./delegated-routes";

export const RESULTS_PATH = "/apps/app_1/envs/env_1/experiments/exp_1/results";
export const OTHER_TENANT_RESULTS_PATH = "/apps/app_1/envs/env_1/experiments/exp_tenant_b/results";

export const NO_RUN_BODY = {
  view: "detailed",
  state: "no_run",
  readiness: { statistical: false, concludeExecutable: false },
  blockedBy: [],
  reasons: ["No Run has been Started for this Experiment. Call experiments_start."],
  recommended_action: "START_A_RUN",
};

export function binding(forwarded: Request[], response: Response): Fetcher {
  return {
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      forwarded.push(new Request(input as RequestInfo, init));
      return response;
    },
  } as unknown as Fetcher;
}

export function stubRun(runId: string, runNumber: number) {
  return {
    id: runId,
    experimentId: "exp_1",
    runNumber,
    status: "running",
    controlVariantId: "variant_control",
    variantSet: JSON.stringify([
      { id: "variant_control", name: "control", value: false },
      { id: "variant_treatment", name: "treatment", value: true },
    ]),
    startedAt: "2026-07-01T00:00:00.000Z",
    plannedDurationDays: null,
    plannedDurationOverrideReason: null,
  };
}

/**
 * `env_9` exists, but under app_2. The read is scoped by App exactly as D1 is
 * (ADR-0018), so an Environment id from another tenant simply is not found.
 */
const ENVIRONMENTS = new Set(["app_1/env_1", "app_2/env_9"]);

export function deps(options: {
  bindings?: DelegationBindings;
  appId?: string;
  experiments?: {
    getExperiment: ReturnType<typeof vi.fn>;
    listRunsForExperiment: ReturnType<typeof vi.fn>;
    getRun?: ReturnType<typeof vi.fn>;
  };
}): {
  authResolver: AuthResolver;
  rateLimiter: RateLimiter;
  repo: Repository;
  delegationBindings?: DelegationBindings;
} {
  const authResolver: AuthResolver = () => ({
    ok: true as const,
    principal: {
      kind: "control-plane-token" as const,
      id: "user_1",
      scopes: [],
      orgId: null,
      appId: options.appId ?? "app_1",
      environmentId: null,
      authDoor: "device_flow" as const,
    },
  });
  const rateLimiter: RateLimiter = () => ({ limited: false });
  return {
    authResolver,
    rateLimiter,
    repo: stubRepo(options.experiments),
    ...(options.bindings ? { delegationBindings: options.bindings } : {}),
  };
}

function stubRepo(experiments?: {
  getExperiment: ReturnType<typeof vi.fn>;
  listRunsForExperiment: ReturnType<typeof vi.fn>;
  getRun?: ReturnType<typeof vi.fn>;
}): Repository {
  return {
    identity: {
      getEnvironment: async ({ appId }: { appId: string }, environmentId: string) =>
        ENVIRONMENTS.has(`${appId}/${environmentId}`) ? { id: environmentId } : null,
      findEnvironmentSelectorCandidates: async ({ appId }: { appId: string }, selector: string) =>
        ENVIRONMENTS.has(`${appId}/${selector}`)
          ? [{ environmentId: selector, environmentKey: "development" }]
          : [],
      getAppMembership: vi.fn(async () => ({ role: "admin" })),
    },
    experiments: {
      getExperiment:
        experiments?.getExperiment ?? vi.fn(async () => ({ id: "exp_1", status: "running" })),
      listRunsForExperiment:
        experiments?.listRunsForExperiment ?? vi.fn(async () => [{ id: "run_7", runNumber: 1 }]),
      getRun: experiments?.getRun ?? vi.fn(async (_scope, runId: string) => stubRun(runId, 1)),
    },
  } as unknown as Repository;
}
