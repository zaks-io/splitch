import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test as base, expect } from "./fixtures";

const repoRoot = resolve(import.meta.dirname, "../..");

interface CliTokenMetadata {
  readonly id: string;
  readonly name: string;
  readonly grants: readonly { target: string; role: string; permissions: readonly string[] }[];
  readonly expiresAt: string;
}

interface CliFixtures {
  readonly cliPersonalAccessToken: {
    readonly token: CliTokenMetadata;
    readonly home: string;
    readonly run: <T>(args: readonly string[]) => Promise<T>;
  };
}

export { expect };

export const test = base.extend<CliFixtures, { builtCliPath: string }>({
  builtCliPath: [
    async ({ playwright: _playwright }, use) => {
      // Deploy and reset workflows do not build the CLI; build its dependency graph once.
      await capturedCommand("pnpm", ["--filter", "@splitch/cli...", "build"], {
        cwd: repoRoot,
        timeout: 180_000,
        label: "CLI smoke build",
      });
      await use(resolve(repoRoot, "apps/cli/dist/cli.js"));
    },
    { scope: "worker", timeout: 180_000 },
  ],
  cliPersonalAccessToken: async ({ builtCliPath, controlPlaneAccessToken, smoke }, use) => {
    const home = await mkdtemp(join(tmpdir(), "splitch-cli-smoke-"));
    try {
      const created = await smoke.controlPlaneSend<{
        token: CliTokenMetadata;
        secret: string;
      }>(controlPlaneAccessToken, "POST", "/personal-access-tokens", {
        name: smoke.uniqueKey("pat-cli-smoke"),
        grants: [{ target: `org:${smoke.config.smokeOrgId}`, role: "member", permissions: [] }],
        expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      });
      try {
        expect(/^pat_[0-9a-f]{32}$/.test(created.token.id), "created CLI PAT id is valid").toBe(
          true,
        );
        expect(
          /^spl_pat_[0-9a-f]{64}$/.test(created.secret),
          "created CLI PAT secret is valid",
        ).toBe(true);
        const run = async <T>(args: readonly string[]): Promise<T> => {
          const stdout = await capturedCommand(
            process.execPath,
            [builtCliPath, ...args, "--json"],
            {
              cwd: home,
              env: {
                ...process.env,
                HOME: home,
                SPLITCH_TOKEN: created.secret,
                SPLITCH_PLATFORM_TARGET: smoke.config.expectedPlatformTarget,
                CONTROL_PLANE_API_ORIGIN: smoke.config.controlPlaneBaseUrl,
                AUTH_API_ORIGIN: smoke.config.authBaseUrl,
                EVALUATION_API_ORIGIN: undefined,
                SPLITCH_APP: undefined,
                SPLITCH_ENV: undefined,
              },
              label: "CLI smoke command",
              timeout: 30_000,
            },
          );
          try {
            return JSON.parse(stdout) as T;
          } catch {
            throw new Error("CLI smoke command did not return JSON");
          }
        };
        const { id, name, grants, expiresAt } = created.token;
        await use({ token: { id, name, grants, expiresAt }, home, run });
        expect(await readdir(home), "token mode leaves the clean HOME untouched").toEqual([]);
      } finally {
        const revoked = await smoke.controlPlaneSend<{ revokedAt: string | null }>(
          controlPlaneAccessToken,
          "POST",
          `/personal-access-tokens/${created.token.id}/revoke`,
        );
        expect(revoked.revokedAt, "CLI smoke PAT was revoked").toEqual(expect.any(String));
      }
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  },
});

async function capturedCommand(
  executable: string,
  args: readonly string[],
  options: {
    cwd: string;
    env?: NodeJS.ProcessEnv;
    label: string;
    timeout: number;
  },
): Promise<string> {
  return new Promise((resolveOutput, reject) => {
    execFile(executable, args, { ...options, encoding: "utf8" }, (error, stdout, stderr) => {
      // Never propagate child errors: their message and output can contain the bearer.
      if (`${stdout}${stderr}`.includes("spl_pat_")) {
        reject(new Error(`${options.label} emitted a PAT secret`));
      } else if (error) {
        reject(new Error(`${options.label} failed before successful completion`));
      } else {
        resolveOutput(stdout);
      }
    });
  });
}
