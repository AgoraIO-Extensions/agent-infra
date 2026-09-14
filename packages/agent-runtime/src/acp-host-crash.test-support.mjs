import { fileURLToPath } from "node:url";
import { GenericAcpRuntimeDriver } from "../dist/index.mjs";

const driver = await GenericAcpRuntimeDriver.open({
	path: process.argv[2],
	configVersion: "configuration-a",
	defaultModelOptionId: "primary",
	defaultReasoningLevel: "high",
	modelOptions: [
		{
			modelOptionId: "primary",
			nativeModelId: "provider/model",
			reasoningLevels: ["high"],
		},
	],
	launch: async () => ({
		command: process.execPath,
		args: [
			fileURLToPath(new URL("./acp-peer.test-support.mjs", import.meta.url)),
		],
		env: {},
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
