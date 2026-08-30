import type { QueryClient } from "@tanstack/react-query";
import type { FlagConfigApi } from "#lib/flags/flag-config-api";

export interface ControlPanelRouterContext {
  readonly queryClient: QueryClient;
  /** Supplied only after the caller has established a control-plane bearer. */
  readonly flagConfigApi?: FlagConfigApi;
}
