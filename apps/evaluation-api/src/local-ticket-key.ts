/**
 * Resolve the Exposure Ticket HMAC key from Worker env. Outside local/pr-ci the
 * dedicated EXPOSURE_TICKET_KEY secret is required (ADR-0048).
 */
export function exposureTicketKeyFromEnv(env: {
  EXPOSURE_TICKET_KEY?: string;
  SPLITCH_PLATFORM_TARGET?: string;
}): string {
  if (env.EXPOSURE_TICKET_KEY !== undefined && env.EXPOSURE_TICKET_KEY.length > 0) {
    return env.EXPOSURE_TICKET_KEY;
  }
  return localOnlyTicketKey(env.SPLITCH_PLATFORM_TARGET);
}

function localOnlyTicketKey(target: string | undefined): string {
  if (target === "local" || target === "pr-ci") {
    return "splitch-local-exposure-ticket-key-do-not-use-outside-local";
  }
  throw new Error("evaluation-api: EXPOSURE_TICKET_KEY is required outside local targets");
}
