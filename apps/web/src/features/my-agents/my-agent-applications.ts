import type {
	Client,
	RequestResult,
} from "../../pilot/generated-v2/client/index.js";
import {
	createAgentApplicationV2,
	getAgentApplicationV2,
	listAgentApplicationsV2,
	updateAgentApplicationV2,
	withdrawAgentApplicationV2,
} from "../../pilot/generated-v2/sdk.gen.js";
import type {
	AgentApplicationCreateRequestV2Writable,
	AgentApplicationProjectionV2,
	AgentApplicationUpdateRequestV2Writable,
	CreateAgentApplicationV2Errors,
	CreateAgentApplicationV2Responses,
	ListAgentApplicationsV2Data,
	ListAgentApplicationsV2Errors,
	ListAgentApplicationsV2Responses,
	UpdateAgentApplicationV2Errors,
	UpdateAgentApplicationV2Responses,
} from "../../pilot/generated-v2/types.gen.js";

type UnavailableState = {
	kind: "unavailable";
	retryable: boolean;
};

export type MyAgentApplicationsState =
	| {
			kind: "ready";
			applications: AgentApplicationProjectionV2[];
	  }
	| UnavailableState;

export type MyAgentApplicationState =
	| { kind: "ready"; application: AgentApplicationProjectionV2 }
	| UnavailableState;

export type AgentApplicationEditAction = "edit" | "resubmit";

const agentApplicationEditActionByStatus: Partial<
	Record<AgentApplicationProjectionV2["status"], AgentApplicationEditAction>
> = {
	pending_approval: "edit",
	rejected: "resubmit",
};

export const agentApplicationEditActionLabels: Record<
	AgentApplicationEditAction,
	string
> = {
	edit: "Edit application",
	resubmit: "Resubmit application",
};

export function getAgentApplicationEditAction(
	application: AgentApplicationProjectionV2,
) {
	return agentApplicationEditActionByStatus[application.status];
}

function requestError(retryable: boolean) {
	return Object.assign(new Error("My Agent data is temporarily unavailable"), {
		retryable,
	});
}

const retryableError = () => requestError(true);
const maximumMyAgentApplicationPages = 100;

function unavailable(error: { retryable?: boolean } | undefined) {
	if (error?.retryable !== false) throw retryableError();

	return { kind: "unavailable" as const, retryable: false };
}

export async function loadMyAgentApplications(
	client?: Client,
): Promise<MyAgentApplicationsState> {
	const applications: AgentApplicationProjectionV2[] = [];
	const cursors = new Set<string>();
	let cursor: string | null = null;
	let pages = 0;

	do {
		if (pages >= maximumMyAgentApplicationPages) throw retryableError();
		pages += 1;
		const query: ListAgentApplicationsV2Data["query"] =
			cursor === null ? undefined : { cursor };
		const result: Awaited<
			RequestResult<
				ListAgentApplicationsV2Responses,
				ListAgentApplicationsV2Errors,
				false
			>
		> = await listAgentApplicationsV2<false>({
			client,
			query,
			responseStyle: "fields",
			throwOnError: false,
		});
		if (!result.data) return unavailable(result.error);

		applications.push(...result.data.items);
		cursor = result.data.nextCursor;
		if (cursor !== null && cursors.has(cursor)) throw retryableError();
		if (cursor !== null) cursors.add(cursor);
	} while (cursor !== null);

	return { kind: "ready", applications };
}

export async function loadMyAgentApplication(
	applicationId: string,
	client?: Client,
): Promise<MyAgentApplicationState> {
	const result = await getAgentApplicationV2({
		client,
		path: { applicationId },
		responseStyle: "fields",
		throwOnError: false,
	});
	return result.data
		? { kind: "ready", application: result.data }
		: unavailable(result.error);
}

export async function createMyAgentApplication(
	body: AgentApplicationCreateRequestV2Writable,
	idempotencyKey: string,
	client?: Client,
): Promise<AgentApplicationProjectionV2> {
	const result: Awaited<
		RequestResult<
			CreateAgentApplicationV2Responses,
			CreateAgentApplicationV2Errors,
			false
		>
	> = await createAgentApplicationV2<false>({
		body,
		client,
		headers: { "Idempotency-Key": idempotencyKey },
		responseStyle: "fields",
		throwOnError: false,
	});
	if (!result.data) throw requestError(result.error?.retryable !== false);

	return result.data;
}

export async function updateMyAgentApplication(
	applicationId: string,
	body: AgentApplicationUpdateRequestV2Writable,
	idempotencyKey: string,
	client?: Client,
): Promise<AgentApplicationProjectionV2> {
	const result: Awaited<
		RequestResult<
			UpdateAgentApplicationV2Responses,
			UpdateAgentApplicationV2Errors,
			false
		>
	> = await updateAgentApplicationV2<false>({
		body,
		client,
		headers: { "Idempotency-Key": idempotencyKey },
		path: { applicationId },
		responseStyle: "fields",
		throwOnError: false,
	});
	if (!result.data) throw requestError(result.error?.retryable !== false);
	if (result.data.applicationId !== applicationId) throw requestError(false);

	return result.data;
}

export async function withdrawMyAgentApplication(
	applicationId: string,
	idempotencyKey: string,
	client?: Client,
): Promise<AgentApplicationProjectionV2> {
	const result = await withdrawAgentApplicationV2({
		client,
		headers: { "Idempotency-Key": idempotencyKey },
		path: { applicationId },
		responseStyle: "fields",
		throwOnError: false,
	});
	if (!result.data) throw requestError(result.error?.retryable !== false);

	return result.data;
}
