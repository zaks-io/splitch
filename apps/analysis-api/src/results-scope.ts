import { ResultsForbiddenError } from "./results-errors";
import {
  optionalObject,
  optionalString,
  requiredPrincipalContext,
  rowObject,
  stringField,
} from "./results-row-fields";

export interface ResultsScope {
  appId: string;
  environmentId: string;
  experimentId: string;
  runId?: string;
  dataWatermark?: string;
}

export function resultsScope(
  input: unknown,
  principalAppId: string | null,
  principalEnvironmentId: string | null,
): ResultsScope {
  const root = rowObject(input);
  const params = rowObject(root.params);
  const query = optionalObject(root.query);
  const body = optionalObject(root.body);
  const pathAppId = stringField(params, "appId");
  const appId = requiredPrincipalContext(principalAppId);
  if (pathAppId !== appId) {
    throw new ResultsForbiddenError("path app_id does not match the authenticated App context");
  }

  // ADR-0027: a control-plane token binds an App and SELECTS the Environment by
  // path within it, so an env-unbound principal legitimately names the path's
  // Environment. A credential that IS env-bound is held to it. Either way the App
  // check above is the tenant boundary, and both pipe reads below are keyed on
  // this pair.
  const environmentId = stringField(params, "environmentId");
  if (principalEnvironmentId !== null && principalEnvironmentId !== environmentId) {
    throw new ResultsForbiddenError(
      "path environment_id does not match the authenticated Environment context",
    );
  }

  return {
    appId,
    environmentId,
    experimentId: stringField(params, "experimentId"),
    runId: optionalString(body.runId ?? query.runId),
    dataWatermark: optionalString(body.dataWatermark),
  };
}
