import { chmod, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { SplitchCliError } from "./errors.js";

interface CliPrincipal {
  readonly userId: string;
  readonly email: string;
}

interface DeviceFlowCredential {
  readonly type: "device_flow";
  readonly refreshToken: string;
  readonly accessToken: string;
  readonly accessTokenExpiresAt: string;
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
    cause: `The credential store could not ${operation}: ${error instanceof Error ? error.message : String(error)}`,
    remediation: "Check credential-file permissions and retry the command",
  });
}

export function isAccessTokenExpired(expiresAt: string, now = Date.now()): boolean {
  const expiresMs = Date.parse(expiresAt);
  if (Number.isNaN(expiresMs)) {
    return true;
  }
  return now >= expiresMs - 30_000;
}
