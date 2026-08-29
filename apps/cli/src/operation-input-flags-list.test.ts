import { expect, it } from "vitest";
import { findCommand } from "./command-registry.js";
import { buildOperationInput } from "./operation-input.js";
import { parseInvocation } from "./parse-args.js";

it("hydrates a scoped flags list for its explicit Environment selector", () => {
  const presentation = findCommand(["flags", "list"]);
  if (!presentation) throw new Error("flags list command is not registered");
  const command = { ...presentation, operationId: "flags_list", needsApp: true };
  const input = buildOperationInput(
    command,
    parseInvocation(["flags", "list", "--json", "--app", "app_cli", "--env", "env_prod"]),
    { appId: "app_cli", environmentId: "env_prod", environmentSource: "flag" },
  );
  expect(input).toEqual({ appId: "app_cli", include: "config", envs: "env_prod" });
});
