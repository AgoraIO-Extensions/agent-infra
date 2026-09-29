import { readFileSync } from "node:fs";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const cert = process.env.PLATFORM_WEB_TLS_CERT_FILE;
const key = process.env.PLATFORM_WEB_TLS_KEY_FILE;
const platformApiTarget =
	process.env.PLATFORM_API_PROXY_TARGET ?? "http://127.0.0.1:3000";
if (Boolean(cert) !== Boolean(key)) {
	throw new Error(
		"Both Platform Web TLS certificate and key files are required",
	);
}

export default defineConfig({
	server: {
		host: "127.0.0.1",
		port: 3001,
		strictPort: true,
		https:
			cert && key
				? { cert: readFileSync(cert), key: readFileSync(key) }
				: undefined,
		proxy: {
			"/api": {
				target: platformApiTarget,
				changeOrigin: false,
			},
			"/auth": {
				target: platformApiTarget,
				changeOrigin: false,
				configure(proxy) {
					proxy.on("proxyReq", (request) => {
						request.setHeader(
							"X-Forwarded-Proto",
							cert && key ? "https" : "http",
						);
					});
				},
			},
		},
	},
	resolve: {
		tsconfigPaths: true,
	},
	test: {
		environment: "jsdom",
	},
	plugins: [
		tailwindcss(),
		tanstackRouter({
			target: "react",
			autoCodeSplitting: true,
		}),
		react(),
	],
});
