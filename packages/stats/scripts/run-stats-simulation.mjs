#!/usr/bin/env node

import { spawn } from "node:child_process";
import process from "node:process";

const defaultsByMode = {
  smoke: {
    seed: "424242",
    iterations: "25",
  },
  audit: {
    seed: "424242",
    iterations: "1000",
  },
};

function parseArgs(args) {
  const parsed = {
    mode: "smoke",
    seed: undefined,
    iterations: undefined,
  };

  for (const arg of args) {
    if (arg === "--") {
      continue;
    }

    const [key, value] = arg.split("=", 2);
    if (key === "--mode" && value) {
      parsed.mode = value;
      continue;
    }
    if (key === "--seed" && value) {
      parsed.seed = value;
      continue;
    }
    if ((key === "--iterations" || key === "--iters") && value) {
      parsed.iterations = value;
      continue;
    }
    throw new Error(`Unknown stats:simulation argument: ${arg}`);
  }

  if (!(parsed.mode in defaultsByMode)) {
    throw new Error("stats:simulation --mode must be smoke or audit");
  }

  const defaults = defaultsByMode[parsed.mode];
  return {
    mode: parsed.mode,
    seed: parsed.seed ?? defaults.seed,
    iterations: parsed.iterations ?? defaults.iterations,
  };
}

function runVitest({ mode, seed, iterations }) {
  console.log(`stats:simulation mode=${mode} seed=${seed} iterations=${iterations}`);
  const child = spawn("pnpm", ["run", "stats:simulation:vitest"], {
    env: {
      ...process.env,
      SPLITCH_STATS_SIMULATION_MODE: mode,
      SPLITCH_STATS_SIMULATION_SEED: seed,
      SPLITCH_STATS_SIMULATION_ITERATIONS: iterations,
    },
    stdio: "inherit",
  });

  child.on("exit", (code, signal) => {
    if (signal) {
      console.error(`stats:simulation terminated by ${signal}`);
      process.exitCode = 1;
      return;
    }
    process.exitCode = code ?? 1;
  });
}

try {
  runVitest(parseArgs(process.argv.slice(2)));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
