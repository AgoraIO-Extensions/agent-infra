import {
	createAgentDefaultRelayKeyCandidateReaderV1,
	createAgentDefaultRelayKeyModelVerifierV1,
	type StandardTemplateModelBindingV1,
} from "@agent-infra/model-catalog";
import {
	type AgentDefaultRelayKeyDependenciesV1,
	AgentDefaultRelayKeyErrorV1,
} from "@agent-infra/platform-core";
import { createPersonalRelayKeyValidatorV1 } from "./relay-key-validation.js";

/** 保存时真实验证的总时长上限：每个组合一次请求，按顺序执行（ADR-0029）。 */
const verificationTimeoutMs = 120_000;

/**
 * Assemble the approved Relay checks for the API write-only path: Key visibility
 * (`/models`) and save-time verification of every (model, level) pair.
 */
export function createAgentDefaultRelayKeyCandidatesV1(input: {
	readonly modelCatalog: {
		readonly revision: string;
		readonly load: (signal: AbortSignal) => Promise<unknown>;
	};
	/** 旧部署配置里的 `reasoningLevels` 兼容读取并忽略（ADR-0029）。 */
	readonly templateBindings: readonly (StandardTemplateModelBindingV1 & {
		readonly reasoningLevels?: readonly string[];
	})[];
	readonly relayEndpointId: string;
	readonly relayBaseUrl: string;
	readonly validation: Parameters<typeof createPersonalRelayKeyValidatorV1>[0];
}): Required<
	Pick<AgentDefaultRelayKeyDependenciesV1, "candidates" | "verify">
> {
	const validate = createPersonalRelayKeyValidatorV1(input.validation);
	const relay = {
		modelCatalog: input.modelCatalog,
		templateBindings: input.templateBindings,
		relayEndpointId: input.relayEndpointId,
		relayBaseUrl: input.relayBaseUrl,
		...(input.validation.fetch ? { fetch: input.validation.fetch } : {}),
	};
	const read = createAgentDefaultRelayKeyCandidateReaderV1({
		...relay,
		validateKey: async () => "valid",
	});
	const probe = createAgentDefaultRelayKeyModelVerifierV1(relay);
	return {
		async candidates(keyValue, configuration) {
			const signal = AbortSignal.timeout(10_000);
			try {
				const validity = await validate(keyValue, signal);
				if (validity !== "valid")
					throw new AgentDefaultRelayKeyErrorV1(
						validity === "invalid" ? "invalid_input" : "unavailable",
					);
				return await read(keyValue, configuration, signal);
			} catch (error) {
				if (error instanceof AgentDefaultRelayKeyErrorV1) throw error;
				throw new AgentDefaultRelayKeyErrorV1("unavailable");
			}
		},
		async verify(keyValue, configuration, combos) {
			const outcome = await probe(
				keyValue,
				configuration,
				combos,
				AbortSignal.timeout(verificationTimeoutMs),
			).catch(() => "unavailable" as const);
			if (outcome === "verified") return;
			throw new AgentDefaultRelayKeyErrorV1(
				outcome === "key_invalid"
					? "invalid_input"
					: outcome === "incompatible"
						? "model_unsupported"
						: "unavailable",
			);
		},
	};
}
