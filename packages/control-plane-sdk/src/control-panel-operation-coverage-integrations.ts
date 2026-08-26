import type { OperationCoverage } from "./control-panel-operation-coverage-types";

/**
 * Integration installation routes. Both Sentry writes name the installation as
 * well as the Environment, so a claim minted for one installation's secret
 * cannot be replayed against another.
 */

const APP = "app_1";
const ENV = "env_1";
const SENTRY = `/apps/${APP}/envs/${ENV}/integrations/sentry/installations`;

export const INTEGRATION_ROUTES: Pick<
  OperationCoverage,
  | "sentry_installations_list"
  | "sentry_installations_create"
  | "sentry_installations_delete"
  | "sentry_secret_rotations_create"
> = {
  sentry_installations_list: {
    route: { method: "GET", pathname: `${SENTRY}` },
    operation: { id: "sentry_installations_list", appId: APP, environmentId: ENV },
  },
  sentry_installations_create: {
    route: { method: "POST", pathname: `${SENTRY}` },
    operation: { id: "sentry_installations_create", appId: APP, environmentId: ENV },
  },
  sentry_installations_delete: {
    route: { method: "DELETE", pathname: `${SENTRY}/inst_1` },
    operation: {
      id: "sentry_installations_delete",
      appId: APP,
      environmentId: ENV,
      installationId: "inst_1",
    },
  },
  sentry_secret_rotations_create: {
    route: { method: "POST", pathname: `${SENTRY}/inst_1/secret-rotations` },
    operation: {
      id: "sentry_secret_rotations_create",
      appId: APP,
      environmentId: ENV,
      installationId: "inst_1",
    },
  },
};
