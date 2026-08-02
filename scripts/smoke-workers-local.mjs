#!/usr/bin/env node
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const workers = [
  {
    alias: "control-plane-api",
    group: "api",
    workspace: "@splitch/control-plane-api",
    cwd: "apps/control-plane-api",
    service: "splitch-control-plane-api",
    port: 8787,
    response: "json",
    testScheduled: true,
  },
  {
    alias: "evaluation-api",
    group: "api",
    workspace: "@splitch/evaluation-api",
    cwd: "apps/evaluation-api",
    service: "splitch-evaluation-api",
    port: 8788,
    response: "json",
  },
  {
    alias: "event-ingest-api",
    group: "api",
    workspace: "@splitch/event-ingest-api",
    cwd: "apps/event-ingest-api",
    service: "splitch-event-ingest-api",
    port: 8789,
    response: "json",
  },
  {
    alias: "analysis-api",
    group: "api",
    workspace: "@splitch/analysis-api",
    cwd: "apps/analysis-api",
    service: "splitch-analysis-api",
    port: 8790,
    response: "json",
    testScheduled: true,
    unsurfacedResultsPath: "/apps/smoke-app/envs/smoke-env/experiments/smoke-exp/results",
  },
  {
    alias: "auth-api",
    group: "api",
    workspace: "@splitch/auth-api",
    cwd: "apps/auth-api",
    service: "splitch-auth-api",
    port: 8791,
    response: "json",
  },
  {
    alias: "mcp-server",
    group: "api",
    workspace: "@splitch/mcp-server",
    cwd: "apps/mcp-server",
    service: "splitch-mcp-server",
    port: 8792,
    response: "json",
  },
  {
    alias: "control-panel",
    group: "frontend",
    workspace: "@splitch/control-panel",
    cwd: "apps/control-panel",
    service: "splitch-control-panel",
    port: 8793,
    response: "html",
  },
  {
    alias: "marketing",
    group: "frontend",
    workspace: "@splitch/marketing",
    cwd: "apps/marketing",
    service: "splitch-marketing",
    port: 8794,
    response: "html",
  },
];

const args = process.argv.slice(2).filter((arg) => arg !== "--");
const selected = selectWorkers(args.length === 0 ? ["api"] : args);
const smokeIp = process.env.SPLITCH_SMOKE_IP ?? "127.0.0.1";
const smokeHost = process.env.SPLITCH_SMOKE_HOST ?? (smokeIp === "0.0.0.0" ? "127.0.0.1" : smokeIp);
const timeoutMs = Number(process.env.SPLITCH_SMOKE_TIMEOUT_MS ?? "30000");

if (selected.length === 0) {
  console.error("smoke:local: no Workers selected");
  process.exit(2);
}

await buildSelectedGraphs(selected);

for (const worker of selected) {
  await smokeWorker(worker);
}

function selectWorkers(tokens) {
  const matches = [];

  for (const token of tokens) {
    const tokenMatches =
      token === "all"
        ? workers
        : workers.filter(
            (worker) =>
              worker.group === token || worker.alias === token || worker.workspace === token,
          );

    if (tokenMatches.length === 0) {
      console.error(`smoke:local: unknown Worker or group '${token}'`);
      process.exit(2);
    }

    for (const worker of tokenMatches) {
      if (!matches.includes(worker)) {
        matches.push(worker);
      }
    }
  }

  return matches;
}

async function buildSelectedGraphs(selectedWorkers) {
  if (process.env.SPLITCH_SMOKE_SKIP_BUILD === "1") {
    return;
  }

  const filters = selectedWorkers.flatMap((worker) => ["--filter", `${worker.workspace}...`]);
  await runCommand("pnpm", [...filters, "build"], {
    cwd: process.cwd(),
    name: "smoke:local:build",
  });
}

async function smokeWorker(worker) {
  const url = `http://${smokeHost}:${worker.port}/`;
  const wranglerArgs = [
    "exec",
    "wrangler",
    "dev",
    "--local",
    "--ip",
    smokeIp,
    "--port",
    String(worker.port),
    "--show-interactive-dev-session=false",
    "--log-level",
    "warn",
  ];

  if (worker.testScheduled) {
    wranglerArgs.push("--test-scheduled");
  }

  const child = spawn("pnpm", wranglerArgs, {
    cwd: worker.cwd,
    env: { ...process.env, CI: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const logs = [];

  child.stdout.on("data", (chunk) => collectLog(logs, chunk));
  child.stderr.on("data", (chunk) => collectLog(logs, chunk));

  try {
    await waitForWorker(url, worker, logs);
    await validateWorkerRouteGuards(url, worker);
    console.log(`smoke:local: ${worker.workspace} ok ${url}`);
  } finally {
    await stopProcess(child);
  }
}

/**
 * Analysis surfaces no route of its own: `/results` is addressed at the Control
 * Plane, which authorizes the caller and forwards over a service binding
 * (ADR-0046). Answering it on this Worker's own hostname would be a second live
 * address for the same operation, reachable without that authorization, so the
 * public door must not answer it at all.
 *
 * The health check above already proved this Worker is up, so a 404 here is the
 * door being closed rather than the Worker being broken.
 */
async function validateWorkerRouteGuards(baseUrl, worker) {
  if (!worker.unsurfacedResultsPath) {
    return;
  }

  const response = await fetch(new URL(worker.unsurfacedResultsPath, baseUrl), {
    signal: AbortSignal.timeout(2000),
  });
  if (response.status !== 404) {
    throw new Error(
      `expected unsurfaced /results HTTP 404 on the public door, got ${response.status}`,
    );
  }
}

async function waitForWorker(url, worker, logs) {
  const deadline = Date.now() + timeoutMs;
  let lastError;

  while (Date.now() < deadline) {
    if (lastProcessLogShowsFatal(logs)) {
      break;
    }

    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
      await validateResponse(response, worker);
      return;
    } catch (error) {
      lastError = error;
      await delay(500);
    }
  }

  const details = logs.slice(-20).join("\n");
  throw new Error(
    `smoke:local: ${worker.workspace} failed at ${url}: ${lastError?.message ?? "not ready"}\n${details}`,
  );
}

async function validateResponse(response, worker) {
  if (response.status !== 200) {
    throw new Error(`expected HTTP 200, got ${response.status}`);
  }

  if (worker.response === "html") {
    const body = await response.text();
    if (!body.includes(worker.service)) {
      throw new Error(`HTML response did not include ${worker.service}`);
    }
    return;
  }

  const body = await response.json();
  if (body.ok !== true) {
    throw new Error("health response ok was not true");
  }
  if (body.service !== worker.service) {
    throw new Error(`expected service ${worker.service}, got ${body.service}`);
  }
  if (body.platformTarget !== "local") {
    throw new Error(`expected platformTarget local, got ${body.platformTarget}`);
  }
}

function collectLog(logs, chunk) {
  const text = chunk.toString();
  process.stderr.write(text);
  for (const line of text.split(/\r?\n/)) {
    if (line.trim()) {
      logs.push(line);
    }
  }
}

function lastProcessLogShowsFatal(logs) {
  const tail = logs.slice(-10).join("\n");
  return /address already in use|EADDRINUSE|Failed to start|Cannot find module/i.test(tail);
}

async function runCommand(command, args, options) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: "inherit",
    });

    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${options.name} failed with exit code ${code}`));
      }
    });
  });
}

async function stopProcess(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  child.kill("SIGTERM");

  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    delay(3000).then(() => child.kill("SIGKILL")),
  ]);
}
