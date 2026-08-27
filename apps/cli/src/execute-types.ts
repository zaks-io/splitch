import type { AuthDeps } from "./auth-token.js";
import type { SdkFactoryOptions } from "./sdks.js";

export interface CliIo {
  readonly log: (line: string) => void;
  readonly error: (line: string) => void;
  /** `--json`: failures also land on stdout as one machine-readable object. */
  readonly json?: boolean;
}

interface CliCommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface CliCommandRunner {
  run(
    command: string,
    args: readonly string[],
    options: { readonly cwd: string; readonly input?: string },
  ): Promise<CliCommandResult>;
}

export interface CliDeps extends AuthDeps, SdkFactoryOptions {
  readonly cwd?: string;
  readonly env?: Record<string, string | undefined>;
  readonly io?: CliIo;
  readonly commandRunner?: CliCommandRunner;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

export interface CliResult {
  readonly exitCode: number;
  readonly payload?: unknown;
}
