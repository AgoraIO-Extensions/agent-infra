import { runPiPodCompanion } from "/app/node_modules/@agent-infra/agent-runtime/dist/index.mjs";

try {
	const template = process.argv[2] ?? "pi";
	if (template !== "pi" && template !== "opencode") throw new Error();
	await runPiPodCompanion(template);
} catch {
	process.stderr.write("RUNTIME_PASEO_COMPANION_UNAVAILABLE\n");
	process.exit(1);
}
