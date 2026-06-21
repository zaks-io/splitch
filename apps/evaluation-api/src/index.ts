import { createHealthResponse } from "@splitch/contracts";

const service = "splitch-evaluation-api";

export default {
  async fetch(): Promise<Response> {
    return Response.json(createHealthResponse(service));
  },
} satisfies ExportedHandler;
