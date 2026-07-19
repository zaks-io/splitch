import {
  parseScopedAnalysisIdentity,
  SCOPED_SERVICE_IDENTITY_HEADER,
  type ScopedAnalysisIdentity,
} from "@splitch/control-plane-sdk/panel-experiments";

const RESULTS_PATH = /^\/apps\/([^/]+)\/envs\/([^/]+)\/experiments\/([^/]+)\/results\/?$/;

export async function scopedIdentityForRequest(
  request: Request,
): Promise<ScopedAnalysisIdentity | null> {
  if (request.method !== "POST") return null;
  const match = new URL(request.url).pathname.match(RESULTS_PATH);
  const identity = parseScopedAnalysisIdentity(request.headers.get(SCOPED_SERVICE_IDENTITY_HEADER));
  if (!match || !identity) return null;
  const [, appId, environmentId, experimentId] = match.map((value) =>
    value ? decodeURIComponent(value) : value,
  );
  const body = (await request
    .clone()
    .json()
    .catch(() => null)) as { runId?: unknown } | null;
  return appId === identity.appId &&
    environmentId === identity.environmentId &&
    experimentId === identity.experimentId &&
    body?.runId === identity.runId
    ? identity
    : null;
}
