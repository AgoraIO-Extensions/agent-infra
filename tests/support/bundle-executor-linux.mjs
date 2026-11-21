import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../../", import.meta.url));
const output = process.argv[2];
if (!output || process.argv.length !== 3)
	throw new Error("Executor fixture output directory is required");
await mkdir(output, { recursive: true });
await build({
	entryPoints: [
		resolve(root, "apps/agent-runtime-host/src/session-instance.linux.ts"),
		resolve(root, "apps/agent-runtime-host/src/executor-instance-pin.linux.ts"),
		resolve(
			root,
			"apps/agent-runtime-host/src/executor-drain-gateway.linux.ts",
		),
	],
	outdir: resolve(output),
	bundle: true,
	platform: "node",
	format: "esm",
	external: ["koffi"],
	banner: {
		js: 'import {createRequire as __fixtureRequire} from "node:module"; const require=__fixtureRequire(import.meta.url);',
	},
	plugins: [
		{
			name: "exact-executor-exports",
			setup(builder) {
				// Link the real implementation files; avoid unrelated SDK browser initializers in this credential-free fixture.
				builder.onResolve({ filter: /^@agent-infra\/agent-runtime$/ }, () => ({
					path: "executor",
					namespace: "fixture-exports",
				}));
				builder.onLoad({ filter: /.*/, namespace: "fixture-exports" }, () => ({
					loader: "ts",
					resolveDir: root,
					contents: [
						"errors",
						"codex-session-executor",
						"codex-executor-bootstrap",
						"codex-executor-control",
						"codex-executor-drain-journal",
						"codex-installation",
					]
						.map(
							(name) =>
								"export * from " +
								JSON.stringify(
									resolve(root, "packages/agent-runtime/src/" + name + ".ts"),
								) +
								";",
						)
						.join("\n"),
				}));
			},
		},
	],
});
