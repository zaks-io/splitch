import type { AuthDeps } from "./auth-token.js";
import type { SdkFactoryOptions } from "./sdks.js";

export interface CliIo {
  readonly log: (line: string) => void;
  readonly error: (line: string) => void;
}

export interface CliDeps extends AuthDeps, SdkFactoryOptions {
  readonly cwd?: string;
  readonly env?: Record<string, string | undefined>;
  readonly io?: CliIo;
}

export interface CliResult {
  readonly exitCode: number;
  readonly payload?: unknown;
}
