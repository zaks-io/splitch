import type { ErrorResponse } from "@splitch/sdk/control-plane";
import { recordFetchRequest } from "./fetch-recording.js";

export interface RecordedRequest {
  readonly url: string;
  readonly method: string;
  readonly authorization: string | null;
  readonly body: unknown;
}

export interface FakeResponse {
  readonly match: (request: RecordedRequest) => boolean;
  readonly status: number;
  readonly body: unknown;
}

export class FakeCliTransport {
  readonly requests: RecordedRequest[] = [];

  constructor(private readonly responses: FakeResponse[]) {}

  fetch: typeof fetch = async (input, init) => {
    const recorded = await recordFetchRequest(input, init);
    this.requests.push(recorded);
    const response = this.responses.find((candidate) => candidate.match(recorded));
    if (!response) {
      throw new Error(`FakeCliTransport: no response for ${recorded.method} ${recorded.url}`);
    }
    return Response.json(response.body, { status: response.status });
  };
}

export function jsonError(code: ErrorResponse["code"], message: string): ErrorResponse {
  if (code === "APPROVAL_REVIEW_REQUIRED") {
    return {
      code,
      message,
      details: {
        approvalRequestId: "apr_01J00000000000000000000000",
        status: "pending",
        policyContexts: [
          {
            environmentId: "env_1",
            changeTypes: ["enabled_state"],
            level: "confirm",
          },
        ],
        recommendedAction: "REVIEW_APPROVAL_REQUEST",
      },
    };
  }
  // Test stubs only need a code + message; details vary by ErrorResponse member.
  return { code, message, details: {} } as ErrorResponse;
}

const timestamp = "2026-07-03T00:00:00.000Z";

export const flagListPage = {
  readTruncated: false,
  readLimit: 200,
  cursor: null,
  items: [
    {
      id: "flag_checkout",
      appId: "app_local",
      key: "checkout",
      name: "Checkout",
      schema: null,
      variants: [{ id: "var_on", name: "on", value: true }],
      defaultVariantId: "var_on",
      createdAt: timestamp,
      updatedAt: timestamp,
    },
  ],
};

export const flagRecord = flagListPage.items[0];

export const createAppResponse = {
  app: {
    id: "app_new",
    organizationId: "org_1",
    name: "New App",
    key: "new-app",
    createdAt: timestamp,
    updatedAt: timestamp,
  },
  environments: [
    {
      id: "env_dev",
      appId: "app_new",
      key: "dev",
      name: "Dev",
      policy: {
        variantAvailability: "allow",
        targetingRolloutValue: "allow",
        enabledState: "allow",
        startExperimentRun: "allow",
      },
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    {
      id: "env_prod",
      appId: "app_new",
      key: "prod",
      name: "Prod",
      policy: {
        variantAvailability: "confirm",
        targetingRolloutValue: "confirm",
        enabledState: "confirm",
        startExperimentRun: "confirm",
      },
      createdAt: timestamp,
      updatedAt: timestamp,
    },
  ],
  clientKeys: [
    {
      keyId: "ck_dev",
      appId: "app_new",
      environmentId: "env_dev",
      keyMaterial: "pk_dev",
      isOriginOpen: true,
      createdAt: timestamp,
    },
    {
      keyId: "ck_prod",
      appId: "app_new",
      environmentId: "env_prod",
      keyMaterial: "pk_prod",
      isOriginOpen: true,
      createdAt: timestamp,
    },
  ],
};

export const flagConfigResponse = {
  flagId: "flag_1",
  environmentId: "env_1",
  version: 1,
  enabled: true,
  availableVariantNames: ["on"],
  targetingRules: [],
  rollout: null,
  experiment: null,
};

export const promoteResponse = {
  ...flagConfigResponse,
  diff: { before: flagConfigResponse, after: flagConfigResponse },
  approvalRequest: null,
};

export const startRunResponse = {
  experimentId: "exp_1",
  run: {
    id: "run_1",
    experimentId: "exp_1",
    environmentId: "env_1",
    status: "running",
    targetingKeyType: "user",
    salt: "salt-1",
    allocation: { control: 50, treatment: 50 },
    variantSet: [
      { id: "var_1", name: "control", value: false },
      { id: "var_2", name: "treatment", value: "on" },
    ],
    targetingRules: [],
    configHash: "hash-1",
    startedAt: timestamp,
    endedAt: null,
    createdAt: timestamp,
  },
  previousRunId: null,
  approvalRequest: null,
  frozenTargetingRules: [],
};

export const testEvalResponse = {
  variantName: "on",
  value: true,
  reason: { type: "default_disabled" as const },
  liveRunId: null,
};

export const verifyResolutionDetails = {
  value: true,
  variantName: "on",
  reason: "DEFAULT" as const,
};

const accessToken = "fixture-access-token";
const refreshToken = "fixture-refresh-token";
export const clientKeyMaterial = "pk_test_client_key";

export function authHeader(): string {
  return `Bearer ${accessToken}`;
}

export function deviceAuthorizationResponse() {
  return {
    device_code: "device-code-1",
    user_code: "ABCD-1234",
    verification_uri: "https://auth.test/device",
    verification_uri_complete: "https://auth.test/device?user_code=ABCD-1234",
    interval: 0,
  };
}

export function deviceTokenResponse() {
  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    token_type: "Bearer",
    expires_in: 3600,
    user_id: "user_test",
    email: "user_test@splitch.test",
    app_id: "app_1",
  };
}

function refreshTokenResponse() {
  return {
    access_token: "refreshed-access-token",
    refresh_token: refreshToken,
    token_type: "Bearer",
    expires_in: 3600,
    email: "user_test@splitch.test",
    app_id: "app_1",
  };
}

export const testEvaluation = {
  variantName: "on",
  value: true,
  reason: { type: "no_match_default" as const },
  liveRunId: null,
};

export const organizationUsage = {
  organizationId: "org_1",
  period: { month: "2026-07", startsAt: timestamp, endsAt: timestamp },
  state: "zero" as const,
  evaluations: 0,
  breakdown: {
    byApp: [],
    byEnvironment: [],
    byFlag: [],
    bySdkRuntime: [],
    byBatch: [],
    bySource: [],
    byExposure: [],
  },
};

/**
 * A refresh-grant mint stub for commands that rebind their token to the Org
 * or App the operation targets (auth.ts withAuthorizationRetry).
 */
export function oauthTokenMint(): FakeResponse {
  return {
    match: (request) => request.url.endsWith("/oauth2/token") && request.method === "POST",
    status: 200,
    body: refreshTokenResponse(),
  };
}

export function storedCredential() {
  return {
    version: 1 as const,
    principal: { userId: "user_test", email: "user_test@splitch.test" },
    credential: {
      type: "device_flow" as const,
      refreshToken,
      accessToken,
      accessTokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      selectedAppId: "app_1",
    },
  };
}

export class RefreshRetryTransport {
  readonly requests: RecordedRequest[] = [];
  flagCalls = 0;

  fetch: typeof fetch = async (input, init) => {
    const recorded = await recordFetchRequest(input, init);
    this.requests.push(recorded);
    if (recorded.url.endsWith("/oauth2/token")) {
      return Response.json(refreshTokenResponse());
    }
    if (recorded.url.includes("/apps/app_1/flags")) {
      this.flagCalls += 1;
      if (this.flagCalls === 1) {
        return Response.json(jsonError("UNAUTHORIZED", "expired"), { status: 401 });
      }
      return Response.json(flagListPage);
    }
    throw new Error(`RefreshRetryTransport: unexpected ${recorded.method} ${recorded.url}`);
  };
}
