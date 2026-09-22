import type { BrowserSessionProjectionV1 } from "../../pilot/generated/types.gen.js";
import type {
	Client,
	RequestResult,
} from "../../pilot/generated-v2/client/index.js";
import {
	commandAgentLifecycleV2,
	updateAgentConfigurationV2 as requestUpdateAgentConfiguration,
} from "../../pilot/generated-v2/sdk.gen.js";
import type {
	AgentConfigurationUpdateRequestV2Writable,
	AgentProjectionV2,
	CommandAgentLifecycleV2Errors,
	CommandAgentLifecycleV2Responses,
	UpdateAgentConfigurationV2Errors,
	UpdateAgentConfigurationV2Responses,
} from "../../pilot/generated-v2/types.gen.js";

export function isAgentConfigurationOwner(
	agent: AgentProjectionV2,
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
	body: AgentConfigurationUpdateRequestV2Writable,
	idempotencyKey: string,
	client?: Client,
): Promise<AgentProjectionV2> {
	const result: Awaited<
		RequestResult<
			UpdateAgentConfigurationV2Responses,
			UpdateAgentConfigurationV2Errors,
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
): Promise<AgentProjectionV2> {
	const result: Awaited<
		RequestResult<
			CommandAgentLifecycleV2Responses,
			CommandAgentLifecycleV2Errors,
			false
		>
	> = await commandAgentLifecycleV2<false>({
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
