import { Buffer } from "node:buffer";
import type {
	RuntimeSavedKeyCandidatesRequestV1,
	RuntimeSavedKeyCandidatesResponseV1,
} from "@agent-infra/contracts/runtime";
import {
	type AgentDefaultRelayKeyEndpointPolicyV1,
	createAgentDefaultRelayKeyCandidateReaderV1,
	createAgentDefaultRelayKeyModelVerifierV1,
	createPersonalRelayKeyValidatorV1,
	type StandardTemplateModelBindingV1,
} from "@agent-infra/model-catalog";
import type { AgentDefaultRelayKeyRequestV1 } from "@agent-infra/platform-core";
import {
	PostgresAgentDefaultRelayKeyStoreV1,
	PostgresRelayKeyVersionStoreV1,
} from "@agent-infra/platform-store";
import type { RelayKeyWorkerDecryptorV1 } from "@agent-infra/secret-store/worker";
import type { WorkerSavedKeyCandidatesReaderV1 } from "./saved-key-candidates-service.js";

type Configuration = Parameters<
	ReturnType<typeof createAgentDefaultRelayKeyCandidateReaderV1>
>[1];

/** Production Worker reader: Store authority, Worker keyring, and catalog stay local. */
export function createProductionSavedKeyCandidatesReaderV1(
	input: AgentDefaultRelayKeyEndpointPolicyV1 & {
		readonly databaseUrl: string;
		readonly decryptor: RelayKeyWorkerDecryptorV1;
		readonly modelCatalog: {
			readonly revision: string;
			readonly load: (signal: AbortSignal) => Promise<unknown>;
		};
		/** 旧部署配置里的 `reasoningLevels` 兼容读取并忽略（ADR-0029）。 */
		readonly templateBindings: readonly (StandardTemplateModelBindingV1 & {
			readonly reasoningLevels?: readonly string[];
		})[];
		readonly validation: Parameters<
			typeof createPersonalRelayKeyValidatorV1
		>[0];
		readonly fetch?: typeof fetch;
	},
): WorkerSavedKeyCandidatesReaderV1 & { close(): Promise<void> } {
	const keyStore = new PostgresAgentDefaultRelayKeyStoreV1({
		databaseUrl: input.databaseUrl,
	});
	const ciphertextStore = new PostgresRelayKeyVersionStoreV1({
		databaseUrl: input.databaseUrl,
	});
	const validate = createPersonalRelayKeyValidatorV1(input.validation);
	const relay = {
		modelCatalog: input.modelCatalog,
		templateBindings: input.templateBindings,
		...(input.relayEndpoints
			? { relayEndpoints: input.relayEndpoints }
			: {
					relayEndpointId: input.relayEndpointId,
					relayBaseUrl: input.relayBaseUrl,
				}),
		...(input.fetch ? { fetch: input.fetch } : {}),
	};
	const candidateReader = createAgentDefaultRelayKeyCandidateReaderV1({
		...relay,
		validateKey: validate,
	});
	const verify = createAgentDefaultRelayKeyModelVerifierV1(relay);
	return {
		async read(request: RuntimeSavedKeyCandidatesRequestV1, signal) {
			signal.throwIfAborted();
			if (request.keyVersion === null)
				throw new Error("SAVED_RELAY_KEY_UNAVAILABLE");
			const authorityRequest: AgentDefaultRelayKeyRequestV1 = {
				userId: request.actorId,
				agentId: request.agentId,
				traceId: request.traceId,
				requestId: request.requestId,
			};
			const authority = await keyStore.execute(async (transaction) => {
				const configuration =
					await transaction.ownedConfiguration(authorityRequest);
				const keyVersion = await transaction.current(request.agentId);
				if (!configuration) throw new Error("SAVED_RELAY_KEY_BINDING_INVALID");
				if (
					configuration.source.kind !== "standard" ||
					!configuration.modelConfiguration ||
					configuration.revision !== request.configurationRevision ||
					keyVersion !== request.keyVersion
				)
					throw new Error("SAVED_RELAY_KEY_BINDING_INVALID");
				return { configuration, keyVersion };
			});
			const binding = await ciphertextStore.current({
				purpose: "agent-default",
				subjectId: request.agentId,
			});
			if (!binding || binding.keyVersion !== authority.keyVersion)
				throw new Error("SAVED_RELAY_KEY_BINDING_INVALID");
			const encrypted = await ciphertextStore.read(binding);
			if (!encrypted) throw new Error("SAVED_RELAY_KEY_UNAVAILABLE");
			const decrypted = await input.decryptor.decrypt({
				encryptedRecord: encrypted,
				expectedBinding: binding,
			});
			if (decrypted.outcome !== "decrypted")
				throw new Error("SAVED_RELAY_KEY_UNAVAILABLE");
			try {
				const keyValue = Buffer.from(decrypted.plaintext).toString("utf8");
				const candidates = await candidateReader(
					keyValue,
					authority.configuration as Configuration,
					signal,
				);
				// 保存时真实验证（ADR-0029）：只在 API 带上新增组合时用已保存的 Key 发请求；
				// 有组合的模型不在 /models 可见清单中时不发请求，由 API 按候选拒绝。
				const verification = request.verify?.every((combo) =>
					candidates.some(
						(candidate) =>
							candidate.endpointId === combo.endpointId &&
							candidate.modelId === combo.modelId,
					),
				)
					? await verify(
							keyValue,
							authority.configuration as Configuration,
							request.verify,
							signal,
						)
					: undefined;
				return {
					schemaVersion: 1,
					agentId: request.agentId,
					configurationRevision: request.configurationRevision,
					keyVersion: request.keyVersion,
					candidates: candidates.map((candidate) => ({
						...candidate,
						reasoningLevels: [...candidate.reasoningLevels],
					})),
					...(verification ? { verification } : {}),
				} satisfies RuntimeSavedKeyCandidatesResponseV1;
			} finally {
				decrypted.plaintext.fill(0);
			}
		},
		async close() {
			await Promise.all([keyStore.close(), ciphertextStore.close()]);
		},
	};
}
