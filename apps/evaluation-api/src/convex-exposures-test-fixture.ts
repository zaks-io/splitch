import type { HandlerArgs } from "@splitch/worker-runtime";

export const EXPOSURE_ID = "00000000-0000-4000-8000-000000000001";
export const INSTALLATION_ID = "00000000-0000-4000-8000-000000000002";

export function requestArgs(): HandlerArgs<unknown> {
  return {
    input: {
      body: {
        exposures: [
          {
            exposureId: EXPOSURE_ID,
            installationId: INSTALLATION_ID,
            flagKey: "checkout",
            experimentId: "exp_1",
            runId: "run_1",
            runConfigHash: "sha256:run-1",
            evaluationContext: {
              targetingKey: "user@example.com",
              idType: "user",
              attributes: {},
            },
            variantName: "treatment",
            exposureAt: "2026-08-25T12:00:00.000Z",
          },
        ],
      },
    },
    principal: {
      kind: "api-key",
      id: "api_key:test",
      scopes: ["data-plane:evaluate"],
      orgId: "org_1",
      appId: "app_1",
      environmentId: "env_1",
      authDoor: null,
    },
    requestId: "request_1",
    request: new Request("https://edge.splitch.dev/api/integrations/convex/exposures"),
  };
}

export function provider() {
  const variants = [
    { id: "control", name: "control", value: false },
    { id: "treatment", name: "treatment", value: true },
  ];
  return {
    async getFlag() {
      return {
        flagKey: "checkout",
        appId: "app_1",
        environmentId: "env_1",
        experimentId: "exp_1",
        enabled: true,
        defaultVariant: "control",
        variants,
        availableVariantNames: ["control", "treatment"],
        targetingRules: [],
        rollout: null,
      };
    },
    async getFlags() {
      return [await this.getFlag()];
    },
    async getExperiment() {
      return {
        experimentId: "exp_1",
        appId: "app_1",
        environmentId: "env_1",
        targetingKeyType: "user",
        status: "running" as const,
        liveRunId: "run_1",
        liveRun: {
          runId: "run_1",
          salt: "salt",
          allocation: { control: 0, treatment: 100 },
          variantSet: variants,
          targetingRules: [],
          targetingKey: "userId",
          configHash: "sha256:run-1",
        },
      };
    },
  };
}

export function resolver(overrides: { endedAt?: string | null } = {}) {
  const variants = [
    { id: "control", name: "control", value: false },
    { id: "treatment", name: "treatment", value: true },
  ];
  return {
    async resolveBatch(_principal: unknown, items: readonly unknown[]) {
      return items.map(() => ({
        status: "found" as const,
        config: {
          appId: "app_1",
          environmentId: "env_1",
          flagKey: "checkout",
          experimentId: "exp_1",
          runId: "run_1",
          runConfigHash: "sha256:run-1",
          targetingKey: "userId",
          targetingKeyType: "user",
          controlVariantId: "control",
          salt: "salt",
          allocation: { control: 0, treatment: 100 },
          variantSet: variants,
          targetingRules: [],
          startedAt: "2026-08-25T11:00:00.000Z",
          endedAt: overrides.endedAt ?? null,
        },
      }));
    },
  };
}

export function readOnlyAssignments() {
  const refuse = async () => {
    throw new Error("read-only");
  };
  return {
    async getAll() {
      return new Map();
    },
    put: refuse,
    putHashed: refuse,
  };
}

export function completedHoldover(writes: unknown[] = []) {
  return {
    async ensure(input: unknown) {
      writes.push(input);
      return { status: "completed" as const };
    },
  };
}

export function saltStore() {
  return {
    async currentKeyVersion() {
      return "v1";
    },
    async saltFor() {
      return new TextEncoder().encode("test-salt") as Uint8Array<ArrayBuffer>;
    },
    async retainedKeyVersions() {
      return ["v1"];
    },
  };
}
