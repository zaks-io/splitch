import { WorkerEntrypoint } from "cloudflare:workers";
import type { VariantValue } from "@splitch/contracts";
import type {
  CloudflareEvaluationContext,
  CloudflareResolutionDetails,
  CloudflareRuntimeStatus,
} from "./public-types";
import { handleConfigurationPush } from "./push";

// biome-ignore lint/performance/noBarrelFile: Wrangler requires the Durable Object class exported from the Worker entrypoint.
export { SplitchState } from "./state";

export default class SplitchCloudflareWorker extends WorkerEntrypoint<Env> {
  override fetch(request: Request): Promise<Response> {
    return handleConfigurationPush(request, this.env);
  }

  async evaluate(flagKey: string, context: CloudflareEvaluationContext): Promise<VariantValue> {
    return (await this.evaluateDetails(flagKey, context)).value;
  }

  evaluateDetails(
    flagKey: string,
    context: CloudflareEvaluationContext,
  ): Promise<CloudflareResolutionDetails> {
    return this.state().evaluateDetails(flagKey, context);
  }

  status(): Promise<CloudflareRuntimeStatus> {
    return this.state().status();
  }

  private state() {
    return this.env.SPLITCH_STATE.getByName(this.env.SPLITCH_INSTALLATION_ID);
  }
}
