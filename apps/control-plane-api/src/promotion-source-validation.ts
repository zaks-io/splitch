import { appScope, type Repository } from "@splitch/db";
import { renderError } from "@splitch/worker-runtime";
import { objectBody, pathParam } from "./handler-input";

export async function validatePromotionSource(
  repo: Repository,
  input: unknown,
  appId: string,
  requestId: string,
) {
  const targetEnvironmentId = pathParam(input, "targetEnvironmentId");
  const flagId = pathParam(input, "flagId");
  const body = objectBody(input);
  const fromEnvironmentId = body.fromEnvironmentId as string;
  const sourceEnvironment = await repo.identity.getEnvironment(appScope(appId), fromEnvironmentId);

  if (!sourceEnvironment) {
    return invalidSource(
      `Environment ${fromEnvironmentId} does not exist in App ${appId}`,
      requestId,
    );
  }
  // Promotion is cross-Environment by definition. Accepting source === target
  // would turn a caller defect into a successful no-op.
  if (fromEnvironmentId === targetEnvironmentId) {
    return invalidSource(
      `source Environment ${fromEnvironmentId} must differ from the target Environment`,
      requestId,
    );
  }

  return { ok: true as const, body, flagId, fromEnvironmentId, targetEnvironmentId };
}

function invalidSource(message: string, requestId: string) {
  return {
    ok: false as const,
    response: renderError(
      {
        code: "VALIDATION_ERROR",
        message: "promotion source Environment is invalid",
        details: { issues: [{ path: ["fromEnvironmentId"], message }] },
      },
      { requestId },
    ),
  };
}
