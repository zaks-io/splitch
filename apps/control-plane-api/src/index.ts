import { createHealthResponse } from "@splitch/contracts";

const service = "splitch-control-plane-api";

export default {
  async fetch(): Promise<Response> {
    return Response.json(createHealthResponse(service));
  },

  scheduled(event, _env, ctx): void {
    ctx.waitUntil(Promise.resolve(console.log(`${service}: demo reaper ${event.cron}`)));
  },
} satisfies ExportedHandler;
