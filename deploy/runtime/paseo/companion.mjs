import { runPaseoPodCompanion } from "/app/node_modules/@agent-infra/agent-runtime/dist/index.mjs";

try {
	const provider = process.env.AGENT_INFRA_PASEO_PROVIDER ?? process.argv[2] ?? "pi";
 if (!["pi", "codex", "claude", "opencode"].includes(provider)) throw new Error();
 await runPaseoPodCompanion(provider);
} catch {
	process.stderr.write("RUNTIME_PASEO_COMPANION_UNAVAILABLE\n");
	process.exit(1);
}
