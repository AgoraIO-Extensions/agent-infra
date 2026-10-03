import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import release from "./codex-release.json" with { type: "json" };

// Controlled persisted mapping; this does not claim production Session acceptance.
export async function seedNativeCommandState(
	directory: string,
	threadId = "native-thread-private",
) {
	const path = join(directory, "driver.json");
	const nativeSessionRef = "session-private";
	const binding = {
		principal: { kind: "user" as const, id: "reader-1" },
		scope: {
			agentId: "agent-1",
			conversationId: "conversation-1",
			executionId: "execution-1",
			sessionGeneration: 1,
		},
	};
	await writeFile(
		path,
		`${JSON.stringify({
			schemaVersion: 1,
			sessions: {
				[nativeSessionRef]: {
					nativeSessionRef: nativeSessionRef,
					agentId: binding.scope.agentId,
					conversationId: binding.scope.conversationId,
					sessionGeneration: binding.scope.sessionGeneration,
					threadId,
					historyMode: "paginated",
					requiredRuntime: {
						schemaVersion: 1,
						provenance: release.provenance,
						artifacts: release.artifacts,
						lane: "official-model-only",
					},
					executions: {
						"execution-1": {
							executionId: "execution-1",
							turnId: "platform-turn-1",
							nativeTurnId: "native-turn-private",
							status: "completed",
						},
					},
				},
			},
			operations: {
				[JSON.stringify([
					binding.scope.agentId,
					binding.scope.conversationId,
					1,
					"submit-turn",
					"execution-1",
				])]: {
					schemaVersion: 1,
					state: "resolved",
					nativeSessionRef,
					configVersion: "config-1",
					record: {
						schemaVersion: 1,
						agentId: binding.scope.agentId,
						conversationId: binding.scope.conversationId,
						sessionGeneration: 1,
						kind: "submit-turn",
						operationId: "execution-1",
						nativeSessionRef,
						result: { outcome: "accepted", status: "completed" },
					},
				},
			},
		})}\n`,
	);
	return { path, nativeSessionRef, binding };
}
