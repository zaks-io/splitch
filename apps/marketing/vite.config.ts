import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  server: {
    host: "127.0.0.1",
    port: 8794,
  },
  preview: {
    host: "127.0.0.1",
    port: 8794,
  },
  plugins: [
    tailwindcss(),
    cloudflare({ viteEnvironment: { name: "ssr" } }),
    tanstackStart({
      prerender: {
        enabled: true,
        autoStaticPathsDiscovery: false,
        crawlLinks: false,
        failOnError: true,
      },
      pages: [{ path: "/", prerender: { enabled: true, outputPath: "/index.html" } }],
    }),
    react(),
  ],
});
