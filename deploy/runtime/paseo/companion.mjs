import { runPiPodCompanion } from "/app/node_modules/@agent-infra/agent-runtime/dist/index.mjs";

try {
	await runPiPodCompanion();
} catch {
	process.stderr.write("RUNTIME_PI_COMPANION_UNAVAILABLE\n");
	process.exit(1);
}
