import { chmod, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { SplitchCliError } from "./errors.js";

/**
 * The opaque `user_id` and nothing else. The auth port deliberately returns no
 * PII (apps/auth-api/src/workos.ts), so an `email` here could only ever be a
 * fabricated default -- which is how `Logged in as unknown` shipped.
 */
interface CliPrincipal {
  readonly userId: string;
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
        return JSON.parse(raw) as CliCredentialFile;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return null;
        }
        throw credentialStoreError(error, "read");
      }
    },
    async save(file) {
      await mkdir(join(path, ".."), { recursive: true });
      await writeFile(path, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
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
