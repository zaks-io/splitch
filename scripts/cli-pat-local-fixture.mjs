import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { createAnalysisSourceServer } from "./local-e2e-analysis-source.mjs";
import { LOCAL_E2E_D1_SEED } from "./local-e2e-fixtures.mjs";
import { startManagedFleet } from "./local-e2e-fleet.mjs";
import {
  apiWorkers,
  createApiFleetConfigs,
  localBindings,
  wranglerBin,
} from "./local-e2e-fleet-config.mjs";
import { capturedChild, stopChild } from "./local-e2e-fleet-supervisor.mjs";

export { capturedChild };
export const repoRoot = resolve(import.meta.dirname, "..");
export class FixtureError extends Error {}
export function check(condition, message) {
  if (!condition) throw new FixtureError(message);
}
export function requireSafeOutput(output) {
  check(
    !/(?:spl_pat_|sk_|pk_)[a-f0-9]{32,}|eyJ[\w-]+\.eyJ[\w-]+\.[\w-]+/.test(output),
    "A diagnostic child emitted a credential; captured output was suppressed",
  );
}
async function requireFreePort(port) {
  const server = createServer();
  await new Promise((done, reject) => {
    server.once("error", () =>
      reject(new FixtureError(`Local diagnostic port ${port} is occupied`)),
    );
    server.listen(port, "127.0.0.1", done);
  });
  await new Promise((done) => server.close(done));
}

// Both CLI smokes use managed ports and a fresh private state directory. No
// migration, SQL or cleanup operation can address the panel's shared persistence.
export async function createLocalPatFixture(signal, options = {}) {
  const runtime = await allocatePrivateRuntime(options.full ?? false);
  try {
    await chmod(runtime.root, 0o700);
    return prepareLocalPatFixture(runtime, signal, options);
  } catch (error) {
    await rm(runtime.root, { recursive: true, force: true });
    throw error;
  }
}

function prepareLocalPatFixture(
  { agent, port, root },
  signal,
  { full = false, owner = false, teardown },
) {
  const state = join(root, "state");
  const origin = `http://127.0.0.1:${port("gateway")}`;
  const issuerOrigin = `http://127.0.0.1:${port("issuer")}`;
  const source = createAnalysisSourceServer(agent, {
    mode: "standalone",
    origin: issuerOrigin,
    audience: origin,
    principal: owner
      ? { sub: "user_local_e2e", scopes: ["app:app_checkout_e2e:owner"] }
      : {
          sub: "user_local_member_e2e",
          scopes: ["org:org_acme_e2e:member", "app:app_checkout_e2e:admin"],
        },
    cleanupAppId: "app_checkout_e2e",
  });
  const env = {
    ...process.env,
    ...localBindings,
    CI: "true",
    WRANGLER_SEND_METRICS: "false",
    WRANGLER_WRITE_LOGS: "false",
    SPLITCH_LOCAL_DEV_FLEET: "false",
  };
  delete env.SPLITCH_TOKEN;
  let managed;
  const commands = [];
  const fixture = {
    root,
    origin,
    issuerOrigin,
    agent,
    sessionToken: source.fixture.accessToken,
    serviceOrigin: (worker) =>
      worker === "control-plane-api" ? origin : `${origin}/__fleet/${worker}`,
    diagnostics: () => ({
      ...managed?.diagnostics(),
      tinybirdDeletes: source.fixture.cleanedEnvironments.size,
    }),
    assertCleanup: (ids) =>
      check(
        ids.every((id) => source.fixture.cleanedEnvironments.has(id)),
        "Analysis cleanup did not reach tenant-scoped Tinybird deletion",
      ),
    async sql(sql, taskSignal = signal) {
      const path = join(root, "fixture.sql");
      await writeFile(path, sql, { mode: 0o600 });
      await wrangler(["d1", "execute", "DB", "--file", path], taskSignal);
    },
    async start() {
      await new Promise((done, reject) => {
        source.once("error", reject);
        source.listen(port("issuer"), "127.0.0.1", done);
      });
      const workers = full ? apiWorkers : ["control-plane-api", "analysis-api"];
      const configs = await createApiFleetConfigs({
        root,
        agent,
        origin,
        issuerOrigin,
        privateKey: source.fixture.privateKey,
        workers,
        teardown,
      });
      managed = await startManagedFleet(agent, {
        signal,
        seed: async () => {
          await wrangler(["d1", "migrations", "apply", "DB"]);
          await fixture.sql(
            LOCAL_E2E_D1_SEED +
              (owner
                ? ""
                : "\nUPDATE app_memberships SET role='admin' WHERE app_id='app_checkout_e2e' AND user_id='user_local_member_e2e';"),
          );
        },
        workers: [
          {
            name: "api-fleet",
            command: process.execPath,
            args: [
              wranglerBin,
              "dev",
              ...configs.flatMap((path) => ["--config", path]),
              "--local",
              "--ip",
              "127.0.0.1",
              "--port",
              String(port("gateway")),
              "--inspector-port",
              String(port("inspector")),
              "--persist-to",
              state,
            ],
            env,
            healthTargets: workers.map((worker) => ({
              name: worker,
              origin: fixture.serviceOrigin(worker),
              service: `splitch-${worker}`,
              checkRunId: worker === "control-plane-api",
            })),
          },
        ],
      });
    },
    run: (task) => managed.run(task),
    async close() {
      try {
        await managed?.close();
      } finally {
        for (const command of commands) await stopChild(command);
        if (source.listening) await new Promise((done) => source.close(done));
        await rm(root, { recursive: true, force: true });
      }
    },
  };
  async function wrangler(args, taskSignal = signal) {
    const running = capturedChild(
      [
        wranglerBin,
        ...args,
        "--local",
        "--config",
        resolve(repoRoot, "packages/db/wrangler.jsonc"),
        "--persist-to",
        state,
      ],
      { env, signal: taskSignal },
    );
    commands.push(running);
    const result = await running.completed;
    requireSafeOutput(result.stdout + result.stderr);
    check(result.code === 0, "Isolated D1 fixture operation failed; private output suppressed");
  }
  return fixture;
}

export function createPatClient(fixture, signal) {
  let sequence = 0;
  const { SPLITCH_CLI_SMOKE_BINARY: binary } = process.env;
  const cliPath = resolve(repoRoot, binary ?? "apps/cli/dist/cli.js");
  async function sessionRequest(method, path, body) {
    const response = await fetch(`${fixture.origin}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${fixture.sessionToken()}`,
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
    });
    check(response.ok, `Session ${method} failed with HTTP ${response.status}`);
    return response.json();
  }
  const client = {
    async mint(grants) {
      const created = await sessionRequest("POST", "/personal-access-tokens", {
        name: "local-e2e",
        grants,
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      });
      check(
        /^pat_[a-f0-9]{32}$/.test(created.token.id) &&
          /^spl_pat_[a-f0-9]{64}$/.test(created.secret),
        "Mint returned invalid PAT material",
      );
      return created;
    },
    revoke: (id) => sessionRequest("POST", `/personal-access-tokens/${id}/revoke`),
    async cli(secret, args, expectedExit = 0) {
      signal.throwIfAborted();
      const cwd = join(fixture.root, "cli");
      await mkdir(cwd, { recursive: true, mode: 0o700 });
      const env = {
        ...process.env,
        SPLITCH_TOKEN: secret,
        SPLITCH_PLATFORM_TARGET: "local",
        CONTROL_PLANE_API_ORIGIN: fixture.origin,
        AUTH_API_ORIGIN: fixture.origin,
      };
      for (const name of ["SPLITCH_APP", "SPLITCH_ENV", "EVALUATION_API_ORIGIN"]) delete env[name];
      const running = capturedChild([cliPath, ...args, "--json"], {
        cwd,
        env,
        signal: AbortSignal.any([signal, AbortSignal.timeout(45_000)]),
      });
      const result = await running.completed;
      requireSafeOutput(result.stderr);
      // Client Key JSON is expected on create/get. It stays captured; API and PAT
      // material must never appear in either success or error output.
      requireSafeOutput(result.stdout.replace(/pk_[a-f0-9]{64}/g, "[Client Key]"));
      check(
        result.code === expectedExit,
        `CLI ${args[0]} ${args[1] ?? ""} exited ${result.code}; expected ${expectedExit}; private output suppressed`,
      );
      try {
        return JSON.parse(result.stdout);
      } catch {
        throw new FixtureError("CLI did not return JSON; private output suppressed");
      }
    },
    async apiKey(secret, appId, environmentId) {
      const output = join(fixture.root, `api-key-${++sequence}.txt`);
      const created = await client.cli(secret, [
        "api-keys",
        "create",
        "--app",
        appId,
        "--env",
        environmentId,
        "--body-json",
        JSON.stringify({ scopes: ["data-plane:evaluate"] }),
        "--output-file",
        output,
      ]);
      check(created.value === null, "API Key appeared in CLI JSON instead of private output-file");
      check(((await stat(output)).mode & 0o077) === 0, "API Key output file is not private");
      const key = (await readFile(output, "utf8")).trim();
      check(/^sk_[a-f0-9]{64}$/.test(key), "Private API Key file has invalid material");
      return key;
    },
  };
  return client;
}

async function allocatePrivateRuntime(full) {
  const { SBX_AGENT_ID: agentId } = process.env;
  const agent = agentId?.replace(/[^a-zA-Z0-9_-]/g, "_");
  check(agent, "SBX_AGENT_ID is required for owned local state");
  const name = full ? "temporary-env" : "cli-pat";
  const allocated = spawnSync(
    "sbx-runtime",
    ["allocate", "--format", "json", `${name}-gateway`, `${name}-inspector`, `${name}-issuer`],
    { cwd: repoRoot, encoding: "utf8" },
  );
  check(allocated.status === 0, "sbx-runtime allocation failed; private output suppressed");
  const allocation = JSON.parse(allocated.stdout);
  const port = (service) => allocation.ports[`${name}-${service}`];
  for (const value of Object.values(allocation.ports)) await requireFreePort(value);
  await mkdir(allocation.state_dir, { recursive: true, mode: 0o700 });
  const root = await mkdtemp(join(allocation.state_dir, `${name}-${agent}-`));
  return { agent, port, root };
}

export async function writeLocalEvidence(name, report) {
  const json = `${JSON.stringify(report, null, 2)}\n`;
  requireSafeOutput(json);
  const directory = resolve(repoRoot, "test-results");
  await mkdir(directory, { recursive: true });
  const path = join(directory, `${name}-${report.agent ?? "unknown"}.json`);
  await writeFile(path, json);
  console.log(`Sanitized evidence: ${path}`);
}
