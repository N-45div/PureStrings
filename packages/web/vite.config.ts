import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/** The PureStrings server the dev server hands API calls, MCP and key sockets to. */
const server = "http://127.0.0.1:7700";

export default defineConfig({
  plugins: [react()],
  // Relative asset paths, so the built app works wherever the server mounts it.
  base: "./",
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: server,
        changeOrigin: true,
        // Send an event stream's headers at once, so the app shows "Live" straight away.
        configure: (proxy) => {
          proxy.on("proxyRes", (proxyRes, _request, response) => {
            if (String(proxyRes.headers["content-type"] ?? "").startsWith("text/event-stream")) process.nextTick(() => response.flushHeaders());
          });
        },
      },
      "/keys/ws": { target: server.replace(/^http/, "ws"), ws: true },
      "/shop": { target: server, changeOrigin: true },
      "/mcp": { target: server, changeOrigin: true },
    },
  },
  build: { outDir: "dist", emptyOutDir: true, chunkSizeWarningLimit: 1500 },
});
