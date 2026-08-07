/**
 * ADR-0029 hard rule: turning a Flag Config off is never Policy-gated.
 *
 * One user-facing wording for every surface that shows enabled-state Policy or
 * that invites a Flag Config update (CLI help, MCP tool description, Panel
 * editor, flag-config update endpoint spec). Do not paraphrase elsewhere —
 * import this constant.
 */
export const KILL_SWITCH_OFF_EXEMPTION =
  "Turning a Flag Config off applies without approval regardless of this level.";
