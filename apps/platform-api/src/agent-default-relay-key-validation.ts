import { createAgentDefaultRelayKeyModelCandidatesV1 } from "@agent-infra/model-catalog";
import {
	type AgentDefaultRelayKeyDependenciesV1,
	AgentDefaultRelayKeyErrorV1,
} from "@agent-infra/platform-core";
import { createPersonalRelayKeyValidatorV1 } from "./relay-key-validation.js";

/** Assemble the existing Relay validator with model-catalog's candidate policy. */
export function createAgentDefaultRelayKeyCandidatesV1(
	input: Omit<
		Parameters<typeof createAgentDefaultRelayKeyModelCandidatesV1>[0],
		"fetch"
	> & {
		readonly validation: Parameters<
			typeof createPersonalRelayKeyValidatorV1
		>[0];
	},
): AgentDefaultRelayKeyDependenciesV1["candidates"] {
	const validate = createPersonalRelayKeyValidatorV1(input.validation);
	const candidates = createAgentDefaultRelayKeyModelCandidatesV1({
		...input,
		...(input.validation.fetch ? { fetch: input.validation.fetch } : {}),
	});
	return async (keyValue, configuration) => {
		const validity = await validate(keyValue);
		if (validity !== "valid")
			throw new AgentDefaultRelayKeyErrorV1(
				validity === "invalid" ? "invalid_input" : "unavailable",
			);
		return candidates(keyValue, configuration);
	};
}
