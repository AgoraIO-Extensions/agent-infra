import type { BrowserSessionProjectionV1 } from "../../pilot/generated/types.gen.js";
import type {
	Client,
	RequestResult,
} from "../../pilot/generated-v2/client/index.js";
import {
	commandAgentLifecycleV2,
	getAgentDefaultRelayKeyCandidatesV2,
	getAgentDefaultRelayKeyV2,
	replaceAgentDefaultRelayKeyV2,
	updateAgentConfigurationV2 as requestUpdateAgentConfiguration,
} from "../../pilot/generated-v2/sdk.gen.js";
import type {
	AgentConfigurationUpdateRequestV2Writable,
	AgentProjectionV2,
	CommandAgentLifecycleV2Errors,
	CommandAgentLifecycleV2Responses,
	GetAgentDefaultRelayKeyCandidatesV2Errors,
	GetAgentDefaultRelayKeyCandidatesV2Responses,
	GetAgentDefaultRelayKeyV2Errors,
	GetAgentDefaultRelayKeyV2Responses,
	ReplaceAgentDefaultRelayKeyV2Errors,
	ReplaceAgentDefaultRelayKeyV2Responses,
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

export type AgentDefaultRelayKeyState = GetAgentDefaultRelayKeyV2Responses[200];
export type AgentDefaultRelayKeyCandidates =
	GetAgentDefaultRelayKeyCandidatesV2Responses[200];

export async function loadAgentDefaultRelayKey(
	agentId: string,
	client?: Client,
): Promise<AgentDefaultRelayKeyState> {
	const result: Awaited<
		RequestResult<
			GetAgentDefaultRelayKeyV2Responses,
			GetAgentDefaultRelayKeyV2Errors,
			false
		>
	> = await getAgentDefaultRelayKeyV2<false>({
		client,
		path: { agentId },
		responseStyle: "fields",
		throwOnError: false,
	});
	if (!result.data) throw requestError(result.error?.retryable !== false);
	return result.data;
}

export async function previewAgentDefaultRelayKeyCandidates(
	agentId: string,
	body: { configurationRevision: number; keyValue: string },
	client?: Client,
): Promise<AgentDefaultRelayKeyCandidates> {
	const result: Awaited<
		RequestResult<
			GetAgentDefaultRelayKeyCandidatesV2Responses,
			GetAgentDefaultRelayKeyCandidatesV2Errors,
			false
		>
	> = await getAgentDefaultRelayKeyCandidatesV2<false>({
		body,
		client,
		path: { agentId },
		responseStyle: "fields",
		throwOnError: false,
	});
	if (!result.data) throw requestError(result.error?.retryable !== false);
	return result.data;
}

export async function replaceAgentDefaultRelayKey(
	agentId: string,
	body: {
		configurationRevision: number;
		expectedVersion: number | null;
		keyValue: string;
	},
	client?: Client,
): Promise<AgentDefaultRelayKeyState> {
	const result: Awaited<
		RequestResult<
			ReplaceAgentDefaultRelayKeyV2Responses,
			ReplaceAgentDefaultRelayKeyV2Errors,
			false
		>
	> = await replaceAgentDefaultRelayKeyV2<false>({
		body,
		client,
		path: { agentId },
		responseStyle: "fields",
		throwOnError: false,
	});
	if (!result.data) throw requestError(result.error?.retryable !== false);
	return result.data;
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
