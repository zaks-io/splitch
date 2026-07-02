import { execFileSync, spawn } from "node:child_process";

const allowNonMain = process.env.SPLITCH_ALLOW_NON_MAIN_PRODUCTION_DEPLOY === "1";
const refName = process.env.GITHUB_REF_NAME ?? currentGitBranch();

if (!allowNonMain && refName !== "main") {
  fail(`Tinybird production deploy must run from main, got ${refName || "unknown"}.`);
}

for (const name of ["TB_TOKEN", "TB_HOST"]) {
  if (!process.env[name]) {
    fail(`${name} is required for Tinybird production deploy.`);
  }
}

await run("tb", ["--no-version-warning", "deploy", "--check"]);
await run("tb", ["--no-version-warning", "deploy", "--wait"]);

function currentGitBranch() {
  try {
    return execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

async function run(command, args) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: {
        ...process.env,
        TB_CLI_TELEMETRY_OPTOUT: "1",
        TB_VERSION_WARNING: "0",
      },
      stdio: "inherit",
    });

    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} ${args.join(" ")} failed with exit code ${code}`));
    });
  }).catch((error) => {
    fail(error.message);
  });
}

function fail(message) {
  console.error(`tinybird:deploy:production: ${message}`);
  process.exit(1);
}
