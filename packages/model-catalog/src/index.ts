import {
	createResponsesModelAccessValidatorV1,
	type ModelAccessValidatorV1,
} from "./access.js";
import { createMessagesModelAccessValidatorV1 } from "./messages-access.js";

export function createModelAccessValidatorV1(
	options: { readonly fetch?: typeof fetch } = {},
): ModelAccessValidatorV1 {
	const responses = createResponsesModelAccessValidatorV1(options);
	const messages = createMessagesModelAccessValidatorV1(options);
	return {
		validate: (input, context) =>
			(input.endpoint.protocol === "anthropic-messages-v1"
				? messages
				: responses
			).validate(input, context),
	};
}

export {
	createFakeModelAccessValidatorV1,
	createResponsesModelAccessValidatorV1,
	type ModelAccessValidatorV1,
} from "./access.js";
export {
	type AgentDefaultKeyBindingV1,
	type AgentDefaultModelAdmissionPortsV1,
	type AgentDefaultModelRequestV1,
	admitAgentDefaultModelsV1,
} from "./agent-default-admission.js";
export * from "./catalog.js";
export { createMessagesModelAccessValidatorV1 } from "./messages-access.js";
export {
	projectRuntimeModelConfigurationV1,
	projectRuntimeModelConfigurationV4,
	type RuntimeModelProjectionV1,
	type RuntimeModelProjectionV4,
	revalidateRuntimeModelCatalogV1,
	revalidateRuntimeModelCatalogV4,
	runtimeModelInjectionV1,
	runtimeModelInjectionV4,
	type StandardTemplateModelBindingV1,
	standardTemplateModelBindingV1,
	standardTemplateModelProtocolV1,
	validateRuntimeModelProjectionV1,
	validateRuntimeModelProjectionV4,
	validateStandardTemplateModelBindingsV1,
} from "./projection.js";
