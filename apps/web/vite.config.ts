import { readFileSync } from "node:fs";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const cert = process.env.PLATFORM_WEB_TLS_CERT_FILE;
const key = process.env.PLATFORM_WEB_TLS_KEY_FILE;
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
				target:
					process.env.PLATFORM_API_PROXY_TARGET ?? "http://127.0.0.1:3000",
				changeOrigin: false,
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
