import { createHealthResponse, parsePlatformTarget } from "@splitch/contracts";
import { AssignmentStoreDurableObject } from "./assignment/assignment-store-do.js";

const service = "splitch-evaluation-api";

type Env = {
  ASSIGNMENTS_KV: KVNamespace;
  SPLITCH_PLATFORM_TARGET?: string;
};

export default {
  async fetch(_request, env): Promise<Response> {
    return Response.json(
      createHealthResponse(service, parsePlatformTarget(env.SPLITCH_PLATFORM_TARGET)),
    );
  },
} satisfies ExportedHandler<Env>;

export { AssignmentStoreDurableObject };
