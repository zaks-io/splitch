import { defineComponent } from "convex/server";
import { v } from "convex/values";

export default defineComponent("splitch", {
  env: {
    SPLITCH_API_KEY: v.string(),
    SPLITCH_ENDPOINT: v.optional(v.string()),
  },
});
