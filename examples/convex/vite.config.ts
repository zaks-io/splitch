import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  const deploymentUrl = loadEnv(mode, process.cwd(), "CONVEX_URL").CONVEX_URL ?? "";

  return {
    plugins: [react()],
    resolve: {
      dedupe: ["convex", "react", "react-dom"],
    },
    define: {
      "import.meta.env.VITE_CONVEX_URL": JSON.stringify(deploymentUrl),
    },
  };
});
