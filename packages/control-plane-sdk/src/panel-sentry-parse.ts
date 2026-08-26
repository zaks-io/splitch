import type { ControlPanelOperation } from "./control-panel-operation.js";

/**
 * The Sentry change-tracking half of the Panel vocabulary.
 *
 * Every path names both the App and the Environment, so the claim binds to the
 * exact Environment being wired into a Sentry organization. That matters more
 * here than for most resources: Sentry's payload carries no environment field,
 * so a delegation minted against a dev Environment must never resolve against
 * the installation that publishes production toggles.
 *
 * Reading an installation and rotating its signing secret are separate
 * operations for the same reason the Flag config read and write are: rendering
 * delivery health must not carry the authority to replace the secret.
 */

const INSTALLATIONS_PATH =
  /^\/apps\/([^/]+)\/envs\/([^/]+)\/integrations\/sentry\/installations\/?$/;
const INSTALLATION_PATH =
  /^\/apps\/([^/]+)\/envs\/([^/]+)\/integrations\/sentry\/installations\/([^/]+)\/?$/;
const SECRET_ROTATIONS_PATH =
  /^\/apps\/([^/]+)\/envs\/([^/]+)\/integrations\/sentry\/installations\/([^/]+)\/secret-rotations\/?$/;

const COLLECTION_METHODS = {
  GET: "sentry_installations_list",
  POST: "sentry_installations_create",
} as const;

export function parseSentryIntegration(
  method: string,
  pathname: string,
): ControlPanelOperation | null {
  return (
    parseSecretRotation(method, pathname) ??
    parseInstallationResource(method, pathname) ??
    parseInstallationCollection(method, pathname)
  );
}

function parseInstallationCollection(
  method: string,
  pathname: string,
): ControlPanelOperation | null {
  const id = COLLECTION_METHODS[method as keyof typeof COLLECTION_METHODS];
  const match = pathname.match(INSTALLATIONS_PATH);
  const appId = decodeMatch(match, 1);
  const environmentId = decodeMatch(match, 2);
  return id && appId && environmentId ? { id, appId, environmentId } : null;
}

function parseInstallationResource(method: string, pathname: string): ControlPanelOperation | null {
  if (method !== "DELETE") return null;
  const match = pathname.match(INSTALLATION_PATH);
  const appId = decodeMatch(match, 1);
  const environmentId = decodeMatch(match, 2);
  const installationId = decodeMatch(match, 3);
  return appId && environmentId && installationId
    ? { id: "sentry_installations_delete", appId, environmentId, installationId }
    : null;
}

function parseSecretRotation(method: string, pathname: string): ControlPanelOperation | null {
  if (method !== "POST") return null;
  const match = pathname.match(SECRET_ROTATIONS_PATH);
  const appId = decodeMatch(match, 1);
  const environmentId = decodeMatch(match, 2);
  const installationId = decodeMatch(match, 3);
  return appId && environmentId && installationId
    ? { id: "sentry_secret_rotations_create", appId, environmentId, installationId }
    : null;
}

function decodeMatch(match: RegExpMatchArray | null, index: number): string | null {
  const value = match?.[index];
  if (!value) return null;
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}
