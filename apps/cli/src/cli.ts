#!/usr/bin/env -S tsx
import { pathToFileURL } from "node:url";
import { createControlPlaneSdk } from "@splitch/control-plane-sdk";
import { initCliObservability } from "@splitch/observability";

const cliObservability = initCliObservability();

export async function runCli(args: readonly string[] = process.argv.slice(2)): Promise<number> {
  const [command] = args;

  if (command === "health") {
    const endpoint = readOption(args, "--endpoint") ?? "http://localhost:8787";
    const controlPlane = createControlPlaneSdk({ baseUrl: endpoint });
    try {
      const health = await controlPlane.health();
      cliObservability.log("info", "cli health", { endpoint, ok: health.ok });
      console.log(JSON.stringify(health, null, 2));
      return 0;
    } catch (error) {
      cliObservability.captureException(error, { endpoint, command });
      throw error;
    }
  }

  console.log("Usage: splitch health --endpoint <url>");
  return command ? 1 : 0;
}

function readOption(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli().then((code) => {
    process.exitCode = code;
  });
}
