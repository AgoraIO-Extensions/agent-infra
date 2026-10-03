import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";

// Run the internal Drivers in a real Host process without adding test-only
// package exports. Node's type transform handles the TypeScript sources.
registerHooks({
	resolve(specifier, context, nextResolve) {
		if (
			specifier.startsWith(".") &&
			specifier.endsWith(".js") &&
			context.parentURL?.startsWith(new URL("./", import.meta.url).href)
		)
			return nextResolve(`${specifier.slice(0, -3)}.ts`, context);
		return nextResolve(specifier, context);
	},
});
const { GenericAcpRuntimeDriver } = await import("./acp-runtime-driver.ts");
const { PiRuntimeDriver } = await import("./pi-runtime-driver.ts");

const runtime = process.argv[3];
const driver = await (runtime === "acp"
	? GenericAcpRuntimeDriver
	: PiRuntimeDriver
).open({
	path: process.argv[2],
	configVersion: "configuration-a",
	defaultModelOptionId: "primary",
	defaultReasoningLevel: "high",
	modelOptions: [
		{
			modelOptionId: "primary",
			nativeModelId: runtime === "acp" ? "provider/model" : "configured/model",
			reasoningLevels: ["high"],
		},
	],
	launch: async () => ({
		command: process.execPath,
		args: [
			fileURLToPath(
				new URL(`./${runtime}-peer.test-support.mjs`, import.meta.url),
			),
		],
		env: { NATIVE_PEER_KEEP_ALIVE: process.argv[4] },
	}),
});
const accepted = await driver.execute({
	schemaVersion: 2,
	kind: "submit-turn",
	agentId: "agent-a",
	conversationId: "conversation-a",
	sessionGeneration: 1,
	executionId: "execution-a",
	turnId: "turn-a",
	operationId: "operation-a",
	input: { text: "synthetic input", attachments: [] },
	selection: {
		schemaVersion: 1,
		modelOptionId: "primary",
		reasoningLevel: "high",
	},
});
for await (const _event of await driver.subscribeEvents(
	accepted.nativeSessionRef,
	"execution-a",
)) {
	/* Drain durable completion. */
}
process.stdout.write(`${JSON.stringify(accepted)}\n`);
