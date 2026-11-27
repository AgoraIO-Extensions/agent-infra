import {
	type AgentDefaultRelayKeyEndpointPolicyV1,
	createAgentDefaultRelayKeyCandidateReaderV1,
	createAgentDefaultRelayKeyModelVerifierV1,
	type StandardTemplateModelBindingV1,
} from "@agent-infra/model-catalog";
import { recordHttpFailureContext } from "@agent-infra/observability/http";
import {
	type AgentDefaultRelayKeyDependenciesV1,
	AgentDefaultRelayKeyErrorV1,
} from "@agent-infra/platform-core";
import type { ReadCommittedModelBindingV1 } from "./deployment-admissions.js";
import { recordRelayStage } from "./model-admission-observation.js";
import { createPersonalRelayKeyValidatorV1 } from "./relay-key-validation.js";

/** 保存时真实验证的总时长上限：每个组合一次请求，按顺序执行（ADR-0029）。 */
const verificationTimeoutMs = 120_000;

/**
 * Assemble the approved Relay checks for the API write-only path: Key visibility
 * (`/models`) and save-time verification of every (model, level) pair.
 */
export function createAgentDefaultRelayKeyCandidatesV1(
	input: AgentDefaultRelayKeyEndpointPolicyV1 & {
		readonly modelCatalog: {
			readonly revision: string;
			readonly load: (signal: AbortSignal) => Promise<unknown>;
		};
		/** 旧部署配置里的 `reasoningLevels` 兼容读取并忽略（ADR-0029）。 */
		readonly templateBindings: readonly (StandardTemplateModelBindingV1 & {
			readonly reasoningLevels?: readonly string[];
		})[];
		readonly committedModelBinding?: ReadCommittedModelBindingV1;
		readonly validation: Parameters<
			typeof createPersonalRelayKeyValidatorV1
		>[0];
	},
): Required<Pick<AgentDefaultRelayKeyDependenciesV1, "candidates" | "verify">> {
	const validate = createPersonalRelayKeyValidatorV1({
		...input.validation,
		observe: recordRelayStage,
	});
	const relay = {
		...input,
		observe: recordRelayStage,
		...(input.validation.fetch ? { fetch: input.validation.fetch } : {}),
	};
	const bindings = structuredClone(input.templateBindings);
	const readCommittedBinding = input.committedModelBinding;
	function readers(
		templateBindings: readonly StandardTemplateModelBindingV1[],
	) {
		const policy = { ...relay, templateBindings };
		return {
			read: createAgentDefaultRelayKeyCandidateReaderV1({
				...policy,
				validateKey: async () => "valid",
			}),
			probe: createAgentDefaultRelayKeyModelVerifierV1(policy),
		};
	}
	const ordinary = readers(bindings);
	async function forConfiguration({
		source,
		ownedAgentId,
	}: Parameters<AgentDefaultRelayKeyDependenciesV1["candidates"]>[1]) {
		if (
			!ownedAgentId ||
			source.kind !== "standard" ||
			!readCommittedBinding ||
			bindings.some(
				(item) =>
					item.templateId === source.templateId &&
					item.imageDigest === source.imageDigest,
			)
		)
			return ordinary;
		const binding = await readCommittedBinding(ownedAgentId, source);
		if (
			!binding ||
			!bindings.some(
				(item) =>
					item.templateId === binding.templateId &&
					item.driver === binding.driver &&
					item.protocol === binding.protocol,
			)
		)
			return ordinary;
		return readers([binding]);
	}
	return {
		async candidates(keyValue, configuration) {
			const signal = AbortSignal.timeout(10_000);
			try {
				const validity = await validate(keyValue, signal);
				if (validity !== "valid")
					throw new AgentDefaultRelayKeyErrorV1(
						validity === "invalid" ? "invalid_input" : "unavailable",
					);
				const { read } = await forConfiguration(configuration);
				return await read(keyValue, configuration, signal);
			} catch (error) {
				if (error instanceof AgentDefaultRelayKeyErrorV1) {
					recordHttpFailureContext({
						failureStep: `model.candidates.${error.code}`,
					});
					throw error;
				}
				recordHttpFailureContext({
					failureStep: "model.candidates.unavailable",
				});
				throw new AgentDefaultRelayKeyErrorV1("unavailable");
			}
		},
		async verify(keyValue, configuration, combos) {
			const signal = AbortSignal.timeout(verificationTimeoutMs);
			const outcome = await forConfiguration(configuration)
				.then(({ probe }) => probe(keyValue, configuration, combos, signal))
				.catch(() => "unavailable" as const);
			if (outcome === "verified") return;
			recordHttpFailureContext({ failureStep: `model.validation.${outcome}` });
			const codes = {
				key_invalid: "relay_key_rejected",
				access_denied: "relay_access_denied",
				codex_client_required: "relay_codex_client_required",
				incompatible: "model_unsupported",
				unavailable: "unavailable",
			} as const;
			throw new AgentDefaultRelayKeyErrorV1(codes[outcome]);
		},
	};
}
