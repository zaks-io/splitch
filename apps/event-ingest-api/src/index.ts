import { createHealthResponse } from "@splitch/contracts";

const service = "splitch-event-ingest-api";

export default {
  async fetch(): Promise<Response> {
    return Response.json(createHealthResponse(service));
  },
} satisfies ExportedHandler;
