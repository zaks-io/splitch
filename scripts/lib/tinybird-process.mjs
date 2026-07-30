import { spawn } from "node:child_process";

// `tb local start` can docker-pull on a cold machine; everything else is far
// faster. Without a bound, a wedged docker daemon hangs pre-push forever.
const TB_TIMEOUT_MS = 10 * 60 * 1000;

function tbSpawn(command, args, cwd, { env, stdio }) {
  return spawn(command, args, {
    cwd,
    timeout: TB_TIMEOUT_MS,
    env: {
      ...process.env,
      ...env,
      TB_CLI_TELEMETRY_OPTOUT: "1",
      TB_VERSION_WARNING: "0",
    },
    stdio,
  });
}

function exitFailureMessage(command, args, code, signal) {
  const invocation = `${command} ${args.join(" ")}`;
  if (signal !== null) {
    return `${invocation} was killed with ${signal} (timeout after ${TB_TIMEOUT_MS / 60000}m, or external kill)`;
  }
  return `${invocation} failed with exit code ${code}`;
}

export async function run(command, args, cwd, options = {}) {
  await new Promise((resolve, reject) => {
    const child = tbSpawn(command, args, cwd, {
      env: options.env,
      stdio: options.input ? ["pipe", "inherit", "inherit"] : "inherit",
    });

    if (options.input) {
      child.stdin.end(options.input);
    }

    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(exitFailureMessage(command, args, code, signal)));
    });
  }).catch((error) => {
    console.error(`tinybird:local: ${error.message}`);
    process.exit(1);
  });
}

export async function output(command, args, cwd) {
  return await new Promise((resolve, reject) => {
    const child = tbSpawn(command, args, cwd, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolve(stdout);
        return;
      }
      reject(new Error(`${exitFailureMessage(command, args, code, signal)}: ${stderr}`));
    });
  }).catch((error) => {
    console.error(`tinybird:local: ${error.message}`);
    process.exit(1);
  });
}

export async function quietExitCodeWithInput(command, args, cwd, input) {
  return await new Promise((resolve) => {
    const child = tbSpawn(command, args, cwd, { stdio: ["pipe", "ignore", "ignore"] });

    child.stdin.end(input);
    child.on("error", () => resolve(127));
    child.on("exit", (code) => resolve(code ?? 1));
  });
}

export async function quietExitCode(command, args, cwd) {
  return await new Promise((resolve) => {
    const child = tbSpawn(command, args, cwd, { stdio: "ignore" });

    child.on("error", () => resolve(127));
    child.on("exit", (code) => resolve(code ?? 1));
  });
}
