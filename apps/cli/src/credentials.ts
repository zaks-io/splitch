import { chmod, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
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
   * `app:<app_id>`, or `org:<selector>`. Absent on files written before
   * rebinding existed — treated as the legacy app default.
   */
  readonly accessTokenBinding?: string;
  readonly selectedAppId?: string;
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

export function createFileCredentialStore(path = CREDENTIALS_PATH): CredentialStore {
  return {
    async load() {
      try {
        const raw = await readFile(path, "utf8");
        if (!raw.trim()) {
          return null;
        }
        return normalizeCredentialFile(JSON.parse(raw) as CliCredentialFile);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return null;
        }
        throw credentialStoreError(error, "read");
      }
    },
    async save(file) {
      await mkdir(join(path, ".."), { recursive: true });
      await writeFile(path, `${JSON.stringify(normalizeCredentialFile(file), null, 2)}\n`, {
        mode: 0o600,
      });
      await chmod(path, 0o600);
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
 * Drop the forbidden `"unknown"` placeholder and empty emails so every on-disk
 * and in-memory principal is one shape: `{ userId }` or `{ userId, email }`
 * with a real address — never a stand-in.
 */
export function normalizeCredentialFile(file: CliCredentialFile): CliCredentialFile {
  const email = realPrincipalEmail(file.principal.email);
  return {
    ...file,
    principal: email
      ? { userId: file.principal.userId, email }
      : { userId: file.principal.userId },
  };
}

export function realPrincipalEmail(email: string | undefined): string | undefined {
  if (typeof email !== "string" || email.length === 0 || email === "unknown") {
    return undefined;
  }
  return email;
}

export function principalNeedsEmailBackfill(principal: CliPrincipal): boolean {
  return realPrincipalEmail(principal.email) === undefined;
}

function credentialStoreError(error: unknown, operation: "read" | "clear"): SplitchCliError {
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
