import { chmod, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { SplitchCliError } from "./errors.js";

/**
 * Principal identity stored with the CLI session. `email` is the verified
 * WorkOS address returned by device-token mint — never a fabricated default
 * like `"unknown"` (ADR-0036). Older credential files may omit it; load
 * strips the forbidden placeholder and refresh backfills the real address.
 */
interface CliPrincipal {
  readonly userId: string;
  readonly email?: string;
}

interface DeviceFlowCredential {
  readonly type: "device_flow";
  readonly refreshToken: string;
  readonly accessToken: string;
  readonly accessTokenExpiresAt: string;
  /**
   * What `accessToken` is bound to: "" (unbound cold-start token),
   * `app:<app_id>`, `org:<selector>`, or `membership-wide-read`. Absent on files written before
   * rebinding existed — treated as the legacy app default.
   */
  readonly accessTokenBinding?: string;
  readonly selectedAppId?: string;
  /**
   * Access-token expiry (ISO) at the moment a best-effort email backfill miss
   * was recorded. While it still equals `accessTokenExpiresAt` and that token
   * is live, skip another refresh so we do not burn rotations. Cleared
   * automatically when the access token rotates or expires — context-only
   * users never hit `withAuthorizationRetry`, so the marker must not stick
   * forever after the Worker starts supplying email.
   */
  readonly emailBackfillUnavailableUntil?: string;
  /**
   * @deprecated Prefer `emailBackfillUnavailableUntil`. Kept so credentials
   * written during the boolean-marker window still suppress retries until the
   * current access token rotates.
   */
  readonly emailBackfillUnavailable?: boolean;
}

export interface CliCredentialFile {
  readonly version: 1;
  readonly principal: CliPrincipal;
  readonly credential: DeviceFlowCredential;
}

export interface CredentialStore {
  load(): Promise<CliCredentialFile | null>;
  save(file: CliCredentialFile): Promise<void>;
  clear(): Promise<void>;
}

const CREDENTIALS_DIR = join(homedir(), ".splitch");
const CREDENTIALS_PATH = join(CREDENTIALS_DIR, "credentials.json");
const CREDENTIAL_DIR_MODE = 0o700;
const CREDENTIAL_FILE_MODE = 0o600;

export function createFileCredentialStore(path = CREDENTIALS_PATH): CredentialStore {
  return {
    async load() {
      try {
        await repairCredentialPermissions(path, { createDir: false });
        const raw = await readFile(path, "utf8");
        if (!raw.trim()) {
          return null;
        }
        return normalizeCredentialFile(JSON.parse(raw) as CliCredentialFile);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return null;
        }
        throw error instanceof SplitchCliError ? error : credentialStoreError(error, "read");
      }
    },
    async save(file) {
      try {
        await repairCredentialPermissions(path, { createDir: true });
        await writeFile(path, `${JSON.stringify(normalizeCredentialFile(file), null, 2)}\n`, {
          mode: CREDENTIAL_FILE_MODE,
        });
        await chmod(path, CREDENTIAL_FILE_MODE);
      } catch (error) {
        throw error instanceof SplitchCliError ? error : credentialStoreError(error, "write");
      }
    },
    async clear() {
      try {
        await unlink(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw credentialStoreError(error, "clear");
        }
      }
    },
  };
}

/**
 * The credential file is 0600; its parent must be 0700 so a world-traversable
 * directory cannot leak the filename or let another user replace it. Repair
 * both on every read and write — a pre-existing 0755 `~/.splitch` is the same
 * leak as creating one.
 */
async function repairCredentialPermissions(
  path: string,
  options: { createDir: boolean },
): Promise<void> {
  const dir = dirname(path);
  if (options.createDir) {
    await mkdir(dir, { recursive: true, mode: CREDENTIAL_DIR_MODE });
  }
  await chmodExisting(dir, CREDENTIAL_DIR_MODE, options.createDir ? "write" : "read");
  await chmodExisting(path, CREDENTIAL_FILE_MODE, options.createDir ? "write" : "read");
}

async function chmodExisting(
  path: string,
  mode: number,
  operation: "read" | "write",
): Promise<void> {
  try {
    await chmod(path, mode);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw credentialStoreError(error, operation);
    }
  }
}

/**
 * Drop the forbidden `"unknown"` placeholder and empty emails so every on-disk
 * and in-memory principal is one shape: `{ userId }` or `{ userId, email }`
 * with a real address — never a stand-in.
 */
function normalizeCredentialFile(file: CliCredentialFile): CliCredentialFile {
  const email = realPrincipalEmail(file.principal.email);
  return {
    ...file,
    principal: email ? { userId: file.principal.userId, email } : { userId: file.principal.userId },
  };
}

function realPrincipalEmail(email: string | undefined): string | undefined {
  if (typeof email !== "string" || email.length === 0 || email === "unknown") {
    return undefined;
  }
  return email;
}

export function principalNeedsEmailBackfill(file: CliCredentialFile): boolean {
  if (realPrincipalEmail(file.principal.email) !== undefined) {
    return false;
  }
  if (emailBackfillBlocked(file)) {
    return false;
  }
  return true;
}

/**
 * A miss is sticky only for the access-token lifetime it was recorded against.
 * Once that token expires or a concurrent mint rotates `accessTokenExpiresAt`,
 * allow another backfill attempt (Worker may now supply email).
 */
function emailBackfillBlocked(file: CliCredentialFile): boolean {
  if (isAccessTokenExpired(file.credential.accessTokenExpiresAt)) {
    return false;
  }
  const until =
    file.credential.emailBackfillUnavailableUntil ??
    (file.credential.emailBackfillUnavailable ? file.credential.accessTokenExpiresAt : undefined);
  return until === file.credential.accessTokenExpiresAt;
}

export function withEmailBackfillUnavailable(file: CliCredentialFile): CliCredentialFile {
  const { emailBackfillUnavailable: _legacy, ...credentialRest } = file.credential;
  return {
    ...file,
    credential: {
      ...credentialRest,
      emailBackfillUnavailableUntil: file.credential.accessTokenExpiresAt,
    },
  };
}

export type EmailUnavailableReason = "backfill_unavailable" | "backfill_pending" | "unverified";

/**
 * Reason the principal has no email, derived from the miss marker's actual
 * presence — never invent `backfill_unavailable` when the next command will
 * still attempt a refresh (rotated-file early return writes no marker).
 */
export function emailUnavailableReason(
  file: CliCredentialFile,
): EmailUnavailableReason | undefined {
  if (realPrincipalEmail(file.principal.email) !== undefined) {
    return undefined;
  }
  if (emailBackfillBlocked(file)) {
    return "backfill_unavailable";
  }
  // Email absent but no sticky marker — backfill will retry on the next call.
  return "backfill_pending";
}

function credentialStoreError(
  error: unknown,
  operation: "read" | "clear" | "write",
): SplitchCliError {
  return new SplitchCliError({
    code: "CLI_CREDENTIAL_STORE_FAILED",
    causeSummary: `The credential store could not ${operation}: ${error instanceof Error ? error.message : String(error)}`,
    remediation: "Check credential-file permissions and retry the command",
    originalError: error,
  });
}

export function isAccessTokenExpired(expiresAt: string, now = Date.now()): boolean {
  const expiresMs = Date.parse(expiresAt);
  if (Number.isNaN(expiresMs)) {
    return true;
  }
  return now >= expiresMs - 30_000;
}
