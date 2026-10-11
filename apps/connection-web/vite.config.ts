import { fileURLToPath } from "node:url";
import { bundleInventory } from "@agent-infra/config/bundle-inventory.ts";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { guideMarkdown } from "./src/features/user-guide/content.ts";

export default defineConfig({
	server: {
		host: "127.0.0.1",
		port: 3002,
		proxy: {
			"/.well-known": { target: "http://127.0.0.1:3013" },
			"/api": { target: "http://127.0.0.1:3013" },
			"/connection/v1": { target: "http://127.0.0.1:3013" },
			"/connection/pat-bindings": { target: "http://127.0.0.1:3013" },
			"/healthz": { target: "http://127.0.0.1:3013" },
			"/mcp": { target: "http://127.0.0.1:3013" },
			"/oauth": { target: "http://127.0.0.1:3013" },
		},
	},
	resolve: {
		tsconfigPaths: true,
	},
	plugins: [
		bundleInventory(
			"connection-web",
			fileURLToPath(new URL("../../", import.meta.url)),
		),
		{
			name: "connection-manual",
			configureServer(server) {
				server.middlewares.use((req, res, next) => {
					if (req.url?.split("?")[0] !== "/connection/help/user-manual.md")
						return next();
					res.setHeader("Content-Type", "text/markdown; charset=utf-8");
					res.setHeader("Cache-Control", "no-store");
					res.end(guideMarkdown());
				});
			},
			generateBundle() {
				this.emitFile({
					type: "asset",
					fileName: "connection/help/user-manual.md",
					source: guideMarkdown(),
				});
			},
		},
		tailwindcss(),
		tanstackRouter({
			target: "react",
			autoCodeSplitting: true,
			routeFileIgnorePattern: "\\.test\\.tsx$",
		}),
		react(),
	],
});
