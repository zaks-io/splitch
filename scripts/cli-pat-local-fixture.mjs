import { spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { stripVTControlCharacters } from "node:util";
import { LOCAL_E2E_D1_SEED } from "./local-e2e-fixtures.mjs";
import { localBindings, wranglerBin } from "./local-e2e-fleet-config.mjs";

export const repoRoot = resolve(import.meta.dirname, "..");
export const issuerOrigin = "http://127.0.0.1:18788";
export const controlPlaneOrigin = "http://127.0.0.1:18790";

export function requireSafeOutput(output) {
  if (output.includes("spl_pat_") || /eyJ[\w-]+\.eyJ[\w-]+\.[\w-]+/.test(output)) {
    throw new Error("A diagnostic child emitted a credential; captured output was suppressed");
  }
}

export function capturedChild(args, { cwd = repoRoot, env = process.env, signal } = {}) {
  const child = spawn(process.execPath, args, {
    cwd,
    env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    signal,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.setEncoding("utf8").on("data", (chunk) => {
    stderr += chunk;
  });
  const completed = new Promise((done) => {
    // Abort and spawn errors still emit close; wait until both output pipes have drained.
    child.once("error", () => {});
    child.once("close", (code) => done({ code, stdout, stderr }));
  });
  return { child, completed, output: () => stdout + stderr };
}

async function stopChild(running) {
  if (running.child.pid) {
    const kill = (signal) => {
      try {
        process.kill(-running.child.pid, signal);
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    };
    kill("SIGTERM");
    const closed = await Promise.race([
      running.completed.then(() => true),
      delay(5_000, false, { ref: false }),
    ]);
    if (!closed) kill("SIGKILL");
  }
  await running.completed;
}

async function requireFreePort(port) {
  const server = createServer();
  await new Promise((done, reject) => {
    server.once("error", () => reject(new Error(`Local diagnostic port ${port} is occupied`)));
    server.listen(port, "127.0.0.1", done);
  });
  await new Promise((done) => server.close(done));
}

export async function createLocalPatFixture(signal) {
  const { SBX_AGENT_ID: agentId } = process.env;
  if (!agentId) throw new Error("SBX_AGENT_ID is required for owned local state");
  for (const port of [18788, 18790, 12027, 12028]) await requireFreePort(port);
  const agent = agentId.replace(/[^a-zA-Z0-9_-]/g, "_");
  const root = await mkdtemp(join(tmpdir(), `splitch-cli-pat-${agent}-`));
  await chmod(root, 0o700);
  const state = join(root, "state");
  const running = [];
  const env = {
    ...process.env,
    ...localBindings,
    CI: "true",
    WRANGLER_SEND_METRICS: "false",
    WRANGLER_WRITE_LOGS: "false",
    SPLITCH_LOCAL_DEV_FLEET: "false",
    SPLITCH_LOCAL_E2E_RUN_ID: agent,
  };
  delete env.SPLITCH_TOKEN;
  const fixture = {
    root,
    async sql(sql) {
      const path = join(root, "fixture.sql");
      await writeFile(path, sql, { mode: 0o600 });
      await wrangler(["d1", "execute", "DB", "--file", path], "D1 fixture SQL");
    },
    async close() {
      try {
        for (const worker of [...running].reverse()) await stopChild(worker);
        for (const worker of running) requireSafeOutput(worker.output());
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
    async start() {
      await wrangler(["d1", "migrations", "apply", "DB"], "D1 migrations");
      // The authority change belongs only to this run's isolated database.
      await fixture.sql(`${LOCAL_E2E_D1_SEED}\nUPDATE app_memberships SET role='admin'
WHERE app_id='app_checkout_e2e' AND user_id='user_local_member_e2e';`);
      await launch(["scripts/local-e2e-analysis-source.mjs"], issuerOrigin, "session issuer");
      const analysis = await config("apps/analysis-api/wrangler.jsonc", "analysis");
      await launch(workerArgs(analysis, 12027, 12028), "http://127.0.0.1:12027", "Analysis Worker");
      const controlPlane = await config("apps/control-plane-api/wrangler.jsonc", "control-plane");
      await launch(workerArgs(controlPlane, 18790, 0), controlPlaneOrigin, "Control Plane Worker");
    },
  };

  async function wrangler(args, label) {
    const run = capturedChild(
      [
        wranglerBin,
        ...args,
        "--local",
        "--config",
        resolve(repoRoot, "packages/db/wrangler.jsonc"),
        "--persist-to",
        state,
      ],
      { env, signal },
    );
    const result = await run.completed;
    requireSafeOutput(result.stdout + result.stderr);
    if (result.code !== 0) throw new Error(`${label} failed; private child output suppressed`);
  }

  async function config(source, name) {
    const sourcePath = resolve(repoRoot, source);
    const original = JSON.parse(await readFile(sourcePath, "utf8"));
    // Local fixture values are vars; retaining required secrets would bind each name twice.
    const { env: _environments, $schema: _schema, secrets: _secrets, ...local } = original;
    const derived = {
      ...local,
      name: `${original.name}-${agent}`,
      main: resolve(dirname(sourcePath), original.main),
      vars: {
        ...original.vars,
        ...localBindings,
        TINYBIRD_API_URL: issuerOrigin,
        AUTH_JWKS_URI: `${issuerOrigin}/.well-known/jwks.json`,
        CONTROL_PLANE_ORIGIN: controlPlaneOrigin,
      },
    };
    if (name === "control-plane") {
      derived.services = original.services.map((service) => ({
        ...service,
        service: `${service.service}-${agent}`,
      }));
      derived.ratelimits = [
        {
          name: "CONTROL_PLANE_ACTOR_RATE_LIMITER",
          namespace_id: "1102",
          simple: { limit: 600, period: 60 },
        },
      ];
    }
    const path = join(root, `${name}.json`);
    await writeFile(path, JSON.stringify(derived), { mode: 0o600 });
    return path;
  }

  function workerArgs(path, port, inspector) {
    return [
      wranglerBin,
      "dev",
      "--config",
      path,
      "--local",
      "--ip",
      "127.0.0.1",
      "--port",
      String(port),
      "--inspector-port",
      String(inspector),
      "--persist-to",
      state,
    ];
  }

  async function launch(args, origin, label) {
    const worker = capturedChild(args, { env });
    running.push(worker);
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      signal.throwIfAborted();
      requireSafeOutput(worker.output());
      if (worker.child.exitCode !== null) {
        throw new Error(
          `${label} exited before health was ready: ${startupDiagnostic(worker.output())}`,
        );
      }
      const healthy = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(1_000) })
        .then((response) => response.ok)
        .catch(() => false);
      if (healthy) return;
      await delay(250);
    }
    throw new Error(`${label} health timed out; private child output suppressed`);
  }

  return fixture;
}

function startupDiagnostic(output) {
  const line = stripVTControlCharacters(output).match(/\[ERROR\][\s\S]{0,1500}/)?.[0];
  if (!line) return "no Wrangler error summary";
  let safe = line;
  for (const value of [...Object.values(process.env), ...Object.values(localBindings)]) {
    if (value && value.length > 7) safe = safe.replaceAll(value, "[redacted]");
  }
  safe = safe.replace(/[A-Za-z0-9_./:+-]{24,}/g, "[redacted]");
  requireSafeOutput(safe);
  return safe;
}
