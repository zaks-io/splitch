import type { META_COMMANDS } from "./command-registry.js";

type MetaCommand = (typeof META_COMMANDS)[number];

export const META_DESCRIPTIONS: Readonly<Record<MetaCommand, string>> = {
  login: "Authenticate the control-plane session with the browser device flow.",
  logout: "Revoke and remove the stored control-plane session.",
  use: "Select the default App and Environment for this project.",
  context: "Show the logged-in principal and the resolved App and Environment.",
  health: "Check the Control Plane API health endpoint.",
};

export const META_EXAMPLES: Readonly<Record<MetaCommand, string>> = {
  login: "splitch login",
  logout: "splitch logout --json",
  use: "splitch use --app checkout --env dev --json",
  context: "splitch context --json",
  health: "splitch health --json",
};
