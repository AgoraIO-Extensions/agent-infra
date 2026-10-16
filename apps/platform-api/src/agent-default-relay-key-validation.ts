import {
	createAgentDefaultRelayKeyCandidateReaderV1,
	type StandardTemplateModelBindingV1,
} from "@agent-infra/model-catalog";
import {
	type AgentDefaultRelayKeyDependenciesV1,
	AgentDefaultRelayKeyErrorV1,
} from "@agent-infra/platform-core";
import { createPersonalRelayKeyValidatorV1 } from "./relay-key-validation.js";

/** Assemble the approved Relay visibility check for the API write-only path. */
export function createAgentDefaultRelayKeyCandidatesV1(input: {
	readonly modelCatalog: {
		readonly revision: string;
		readonly load: (signal: AbortSignal) => Promise<unknown>;
	};
	readonly templateBindings: readonly (StandardTemplateModelBindingV1 & {
		readonly reasoningLevels: readonly string[];
	})[];
	readonly relayEndpointId: string;
	readonly relayBaseUrl: string;
	readonly validation: Parameters<typeof createPersonalRelayKeyValidatorV1>[0];
}): AgentDefaultRelayKeyDependenciesV1["candidates"] {
	const validate = createPersonalRelayKeyValidatorV1(input.validation);
	const read = createAgentDefaultRelayKeyCandidateReaderV1({
		modelCatalog: input.modelCatalog,
		templateBindings: input.templateBindings,
		relayEndpointId: input.relayEndpointId,
		relayBaseUrl: input.relayBaseUrl,
		validateKey: validate,
		...(input.validation.fetch ? { fetch: input.validation.fetch } : {}),
	});
	return async (keyValue, configuration) => {
		try {
			return await read(keyValue, configuration, AbortSignal.timeout(10_000));
		} catch {
			throw new AgentDefaultRelayKeyErrorV1("unavailable");
		}
	};
}
