import splitch from "@splitch/convex/convex.config";
import { defineApp } from "convex/server";
import { v } from "convex/values";

const app = defineApp({ env: { SPLITCH_API_KEY: v.string() } });

app.use(splitch, {
  httpPrefix: "/integrations/splitch/",
  env: {
    SPLITCH_API_KEY: app.env.SPLITCH_API_KEY,
    SPLITCH_ENDPOINT: "https://edge.preview.splitch.dev",
  },
});

export default app;
