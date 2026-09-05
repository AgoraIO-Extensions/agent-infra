import type {
	Client,
	RequestResult,
} from "../../pilot/generated/client/index.js";
import {
	createAgentApplication,
	getAgentApplication,
	listAgentApplications,
	updateAgentApplication,
	withdrawAgentApplication,
} from "../../pilot/generated/sdk.gen.js";
import type {
	AgentApplicationCreateRequestV1Writable,
	AgentApplicationProjectionV1,
	AgentApplicationUpdateRequestV1Writable,
	CreateAgentApplicationErrors,
	CreateAgentApplicationResponses,
	ListAgentApplicationsData,
	ListAgentApplicationsErrors,
	ListAgentApplicationsResponses,
	UpdateAgentApplicationErrors,
	UpdateAgentApplicationResponses,
} from "../../pilot/generated/types.gen.js";

type UnavailableState = {
	kind: "unavailable";
	retryable: boolean;
};

export type MyAgentApplicationsState =
	| {
			kind: "ready";
			applications: AgentApplicationProjectionV1[];
	  }
	| UnavailableState;

export type MyAgentApplicationState =
	| { kind: "ready"; application: AgentApplicationProjectionV1 }
	| UnavailableState;

export type AgentApplicationEditAction = "edit" | "resubmit";

const agentApplicationEditActionByStatus: Partial<
	Record<AgentApplicationProjectionV1["status"], AgentApplicationEditAction>
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
	application: AgentApplicationProjectionV1,
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
	const applications: AgentApplicationProjectionV1[] = [];
	const cursors = new Set<string>();
	let cursor: string | null = null;
	let pages = 0;

	do {
		if (pages >= maximumMyAgentApplicationPages) throw retryableError();
		pages += 1;
		const query: ListAgentApplicationsData["query"] =
			cursor === null ? undefined : { cursor };
		const result: Awaited<
			RequestResult<
				ListAgentApplicationsResponses,
				ListAgentApplicationsErrors,
				false
			>
		> = await listAgentApplications<false>({
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
	const result = await getAgentApplication({
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
	body: AgentApplicationCreateRequestV1Writable,
	idempotencyKey: string,
	client?: Client,
): Promise<AgentApplicationProjectionV1> {
	const result: Awaited<
		RequestResult<
			CreateAgentApplicationResponses,
			CreateAgentApplicationErrors,
			false
		>
	> = await createAgentApplication<false>({
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
	body: AgentApplicationUpdateRequestV1Writable,
	idempotencyKey: string,
	client?: Client,
): Promise<AgentApplicationProjectionV1> {
	const result: Awaited<
		RequestResult<
			UpdateAgentApplicationResponses,
			UpdateAgentApplicationErrors,
			false
		>
	> = await updateAgentApplication<false>({
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
): Promise<AgentApplicationProjectionV1> {
	const result = await withdrawAgentApplication({
		client,
		headers: { "Idempotency-Key": idempotencyKey },
		path: { applicationId },
		responseStyle: "fields",
		throwOnError: false,
	});
	if (!result.data) throw requestError(result.error?.retryable !== false);

	return result.data;
}
