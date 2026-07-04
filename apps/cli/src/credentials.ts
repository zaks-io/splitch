import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

interface CliPrincipal {
  readonly userId: string;
  readonly email: string;
}

interface DeviceFlowCredential {
  readonly type: "device_flow";
  readonly refreshToken: string;
  readonly accessToken: string;
  readonly accessTokenExpiresAt: string;
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
        return JSON.parse(raw) as CliCredentialFile;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return null;
        }
        throw error;
      }
    },
    async save(file) {
      await mkdir(join(path, ".."), { recursive: true });
      await writeFile(path, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
      await chmod(path, 0o600);
    },
    async clear() {
      try {
        await writeFile(path, "");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
      }
    },
  };
}

export function isAccessTokenExpired(expiresAt: string, now = Date.now()): boolean {
  const expiresMs = Date.parse(expiresAt);
  if (Number.isNaN(expiresMs)) {
    return true;
  }
  return now >= expiresMs - 30_000;
}
