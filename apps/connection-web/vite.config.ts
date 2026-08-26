import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
	server: {
		host: "127.0.0.1",
		port: 3002,
		proxy: {
			"/.well-known": { target: "http://127.0.0.1:3013" },
			"/api": { target: "http://127.0.0.1:3013" },
			"/connection/v1": { target: "http://127.0.0.1:3013" },
			"/healthz": { target: "http://127.0.0.1:3013" },
			"/mcp": { target: "http://127.0.0.1:3013" },
			"/oauth": { target: "http://127.0.0.1:3013" },
		},
	},
	resolve: {
		tsconfigPaths: true,
	},
	plugins: [
		tailwindcss(),
		tanstackRouter({
			target: "react",
			autoCodeSplitting: true,
			routeFileIgnorePattern: "\\.test\\.tsx$",
		}),
		react(),
	],
});
