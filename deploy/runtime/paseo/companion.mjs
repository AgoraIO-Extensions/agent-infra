import { runPaseoPodCompanion } from "/app/node_modules/@agent-infra/agent-runtime/dist/index.mjs";

try {
	await runPaseoPodCompanion(process.env.AGENT_INFRA_PASEO_PROVIDER ?? "pi");
} catch {
	process.stderr.write("RUNTIME_PASEO_COMPANION_UNAVAILABLE\n");
	process.exit(1);
}
