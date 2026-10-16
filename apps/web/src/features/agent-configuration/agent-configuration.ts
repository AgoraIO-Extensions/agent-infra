import type { BrowserSessionProjectionV1 } from "../../pilot/generated/types.gen.js";
import type {
	Client,
	RequestResult,
} from "../../pilot/generated-v2/client/index.js";
import {
	commandAgentLifecycleV2,
	getAgentDefaultRelayKeyCandidatesV2,
	getAgentDefaultRelayKeySavedCandidatesV2,
	getAgentDefaultRelayKeyV2,
	replaceAgentDefaultRelayKeyV2,
	updateAgentConfigurationV2 as requestUpdateAgentConfiguration,
	updateAgentSavedModelConfigurationV2,
} from "../../pilot/generated-v2/sdk.gen.js";
import type {
	AgentApiLifecycleAcceptedResponseV1,
	AgentConfigurationUpdateRequestV2Writable,
	AgentProjectionV2,
	CommandAgentLifecycleV2Errors,
	CommandAgentLifecycleV2Responses,
	GetAgentDefaultRelayKeyCandidatesV2Errors,
	GetAgentDefaultRelayKeyCandidatesV2Responses,
	GetAgentDefaultRelayKeySavedCandidatesV2Errors,
	GetAgentDefaultRelayKeySavedCandidatesV2Responses,
	GetAgentDefaultRelayKeyV2Errors,
	GetAgentDefaultRelayKeyV2Responses,
	ReplaceAgentDefaultRelayKeyV2Errors,
	ReplaceAgentDefaultRelayKeyV2Responses,
	UpdateAgentConfigurationV2Errors,
	UpdateAgentConfigurationV2Responses,
	UpdateAgentSavedModelConfigurationV2Data,
	UpdateAgentSavedModelConfigurationV2Errors,
	UpdateAgentSavedModelConfigurationV2Responses,
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
export type AgentDefaultRelayKeySavedCandidates =
	GetAgentDefaultRelayKeySavedCandidatesV2Responses[200];
/** 候选模型，连同检查时看到的 Key 版本；保存时与 `configurationRevision` 一起作为 expected 值。 */
export type AgentDefaultRelayKeyCheck = AgentDefaultRelayKeyCandidates & {
	keyVersion: number | null;
};
export type AgentSavedModelConfigurationUpdate =
	UpdateAgentSavedModelConfigurationV2Data["body"];

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

/**
 * Read the metadata projection for the already persisted Agent default Relay Key.
 * The generated endpoint is GET-only here: the browser never sends or receives
 * Key material, and the Worker decrypts the saved value transiently.
 */
export async function loadAgentDefaultRelayKeySavedCandidates(
	agentId: string,
	client?: Client,
): Promise<AgentDefaultRelayKeySavedCandidates> {
	const result: Awaited<
		RequestResult<
			GetAgentDefaultRelayKeySavedCandidatesV2Responses,
			GetAgentDefaultRelayKeySavedCandidatesV2Errors,
			false
		>
	> = await getAgentDefaultRelayKeySavedCandidatesV2<false>({
		client,
		path: { agentId },
		responseStyle: "fields",
		throwOnError: false,
	});
	if (!result.data) throw requestError(result.error?.retryable !== false);
	return result.data;
}

/**
 * 读取当前配置修订与 Key 版本后检查 Key 可见的模型。返回的修订和版本就是保存时作为
 * expected 值带回的那一组：检查之后任何一方变化，服务端都会拒绝（#2421）。
 */
export async function checkAgentDefaultRelayKey(
	agentId: string,
	keyValue: string,
	client?: Client,
): Promise<AgentDefaultRelayKeyCheck> {
	const state = await loadAgentDefaultRelayKey(agentId, client);
	const candidates = await previewAgentDefaultRelayKeyCandidates(
		agentId,
		{ configurationRevision: state.configurationRevision, keyValue },
		client,
	);
	return { ...candidates, keyVersion: state.isSet ? state.keyVersion : null };
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

export async function updateAgentSavedModelConfiguration(
	agentId: string,
	body: AgentSavedModelConfigurationUpdate,
	idempotencyKey: string,
	client?: Client,
): Promise<AgentProjectionV2> {
	const result: Awaited<
		RequestResult<
			UpdateAgentSavedModelConfigurationV2Responses,
			UpdateAgentSavedModelConfigurationV2Errors,
			false
		>
	> = await updateAgentSavedModelConfigurationV2<false>({
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
): Promise<AgentProjectionV2 | AgentApiLifecycleAcceptedResponseV1> {
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
