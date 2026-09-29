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
export * from "./catalog.js";
export { createMessagesModelAccessValidatorV1 } from "./messages-access.js";
export {
	projectRuntimeModelConfigurationV1,
	type RuntimeModelProjectionV1,
	revalidateRuntimeModelCatalogV1,
	runtimeModelInjectionV1,
	type StandardTemplateModelBindingV1,
	standardTemplateModelProtocolV1,
	validateRuntimeModelProjectionV1,
} from "./projection.js";
