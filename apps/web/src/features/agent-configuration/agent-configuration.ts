import type {
	Client,
	RequestResult,
} from "../../pilot/generated/client/index.js";
import {
	commandAgentLifecycle,
	updateAgentConfiguration as requestUpdateAgentConfiguration,
} from "../../pilot/generated/sdk.gen.js";
import type {
	AgentConfigurationUpdateRequestV1Writable,
	AgentProjectionV1,
	BrowserSessionProjectionV1,
	CommandAgentLifecycleErrors,
	CommandAgentLifecycleResponses,
	UpdateAgentConfigurationErrors,
	UpdateAgentConfigurationResponses,
} from "../../pilot/generated/types.gen.js";

export function isAgentConfigurationOwner(
	agent: AgentProjectionV1,
	session: BrowserSessionProjectionV1,
) {
	return agent.configuration.owners.some(
		(owner) => owner.userId === session.user.userId,
	);
}

function requestError(retryable: boolean) {
	return Object.assign(
		new Error("Agent configuration is temporarily unavailable"),
		{
			retryable,
		},
	);
}

export async function updateAgentConfiguration(
	agentId: string,
	body: AgentConfigurationUpdateRequestV1Writable,
	idempotencyKey: string,
	client?: Client,
): Promise<AgentProjectionV1> {
	const result: Awaited<
		RequestResult<
			UpdateAgentConfigurationResponses,
			UpdateAgentConfigurationErrors,
			false
		>
	> = await requestUpdateAgentConfiguration<false>({
		body,
		client,
		headers: { "Idempotency-Key": idempotencyKey },
		path: { agentId },
		responseStyle: "fields",
		throwOnError: false,
	});
	if (!result.data) throw requestError(result.error?.retryable !== false);
	if (result.data.agentId !== agentId) throw requestError(false);

	return result.data;
}

export async function upgradeAgentCustomImage(
	agentId: string,
	imageReference: string,
	idempotencyKey: string,
	client?: Client,
): Promise<AgentProjectionV1> {
	const result: Awaited<
		RequestResult<
			CommandAgentLifecycleResponses,
			CommandAgentLifecycleErrors,
			false
		>
	> = await commandAgentLifecycle<false>({
		body: {
			schemaVersion: 1,
			command: "upgrade_custom_image",
			imageReference,
		},
		client,
		headers: { "Idempotency-Key": idempotencyKey },
		path: { agentId },
		responseStyle: "fields",
		throwOnError: false,
	});
	if (!result.data) throw requestError(result.error?.retryable !== false);
	if (result.data.agentId !== agentId) throw requestError(false);

	return result.data;
}
