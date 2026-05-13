import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { DEFAULT_STAR_DELIVERY_REST_BASE } from "./src/starDeliveryDefaults";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, __dirname, "");
  const proxyTarget =
    env.VITE_PROXY_TARGET ||
    env.VITE_API_BASE_URL ||
    DEFAULT_STAR_DELIVERY_REST_BASE;

  return {
    plugins: [react()],
    resolve: {
      alias: {
        "@cli": path.resolve(__dirname, "../src"),
      },
    },
    server: {
      port: 5173,
      fs: {
        allow: [path.resolve(__dirname), path.resolve(__dirname, "..")],
      },
      proxy: {
        "/__api": {
          target: proxyTarget.replace(/\/+$/, ""),
          changeOrigin: true,
          secure: true,
          rewrite: (p) => p.replace(/^\/__api/, "") || "/",
        },
      },
    },
  };
});
