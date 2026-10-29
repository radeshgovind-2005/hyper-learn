import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The UI. `npm run dev` serves it with hot reload and proxies the agent's WebSocket and RPC traffic to
// `wrangler dev` on :8787; `npm run build:web` writes web/dist, which the Worker serves as static assets.
export default defineConfig({
  root: "web",
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true },
  server: {
    port: 5173,
    proxy: { "/agents": { target: "http://localhost:8787", ws: true } },
  },
});
