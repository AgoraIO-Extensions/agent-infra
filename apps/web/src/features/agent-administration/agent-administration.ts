import type {
	Client,
	RequestResult,
} from "../../pilot/generated/client/index.js";
import {
	getCurrentSession,
	listPendingAgentApplications,
	commandAgentLifecycle as requestAgentLifecycle,
	decideAgentApplication as requestApplicationDecision,
} from "../../pilot/generated/sdk.gen.js";
import type {
	AgentApplicationProjectionV1,
	AgentLifecycleCommandRequestV1,
	AgentProjectionV1,
	ApprovalDecisionRequestV1,
	BrowserSessionProjectionV1,
	CommandAgentLifecycleErrors,
	CommandAgentLifecycleResponses,
	DecideAgentApplicationErrors,
	DecideAgentApplicationResponses,
	GetCurrentSessionErrors,
	GetCurrentSessionResponses,
	ListPendingAgentApplicationsData,
	ListPendingAgentApplicationsErrors,
	ListPendingAgentApplicationsResponses,
} from "../../pilot/generated/types.gen.js";

type UnavailableState = {
	kind: "unavailable";
	retryable: boolean;
};

export type PendingAgentApplicationsState =
	| { kind: "ready"; applications: AgentApplicationProjectionV1[] }
	| UnavailableState;

export type BrowserSessionState =
	| { kind: "ready"; session: BrowserSessionProjectionV1 }
	| UnavailableState;

export type AgentApplicationDecision =
	| Pick<
			Extract<ApprovalDecisionRequestV1, { decision: "approve" }>,
			"decision"
	  >
	| Pick<
			Extract<ApprovalDecisionRequestV1, { decision: "reject" }>,
			"decision" | "reason"
	  >;

export type AgentLifecycleCommand = Exclude<
	AgentLifecycleCommandRequestV1["command"],
	"upgrade_custom_image"
>;

const maximumPendingApplicationPages = 100;

function requestError(retryable: boolean) {
	return Object.assign(
		new Error("Agent administration is temporarily unavailable"),
		{
			retryable,
		},
	);
}

function retryableError() {
	return requestError(true);
}

function unavailable(error: { retryable?: boolean } | undefined) {
	if (error?.retryable !== false) throw retryableError();

	return { kind: "unavailable" as const, retryable: false };
}

export async function loadBrowserSession(
	client?: Client,
): Promise<BrowserSessionState> {
	const result: Awaited<
		RequestResult<GetCurrentSessionResponses, GetCurrentSessionErrors, false>
	> = await getCurrentSession<false>({
		client,
		responseStyle: "fields",
		throwOnError: false,
	});
	return result.data
		? { kind: "ready", session: result.data }
		: unavailable(result.error);
}

export async function loadPendingAgentApplications(
	client?: Client,
): Promise<PendingAgentApplicationsState> {
	const applications: AgentApplicationProjectionV1[] = [];
	const cursors = new Set<string>();
	let cursor: string | null = null;
	let pages = 0;

	do {
		if (pages >= maximumPendingApplicationPages) throw retryableError();
		pages += 1;
		const query: ListPendingAgentApplicationsData["query"] =
			cursor === null ? undefined : { cursor };
		const result: Awaited<
			RequestResult<
				ListPendingAgentApplicationsResponses,
				ListPendingAgentApplicationsErrors,
				false
			>
		> = await listPendingAgentApplications<false>({
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

export async function decideAgentApplication(
	applicationId: string,
	decision: AgentApplicationDecision,
	idempotencyKey: string,
	client?: Client,
): Promise<AgentApplicationProjectionV1> {
	const result: Awaited<
		RequestResult<
			DecideAgentApplicationResponses,
			DecideAgentApplicationErrors,
			false
		>
	> = await requestApplicationDecision<false>({
		client,
		path: { applicationId },
		headers: { "Idempotency-Key": idempotencyKey },
		body: { schemaVersion: 1, ...decision },
		responseStyle: "fields",
		throwOnError: false,
	});
	if (!result.data) throw requestError(result.error?.retryable !== false);
	if (result.data.applicationId !== applicationId) throw requestError(false);

	return result.data;
}

export async function commandAgentLifecycle(
	agentId: string,
	command: AgentLifecycleCommand,
	idempotencyKey: string,
	client?: Client,
): Promise<AgentProjectionV1> {
	const result: Awaited<
		RequestResult<
			CommandAgentLifecycleResponses,
			CommandAgentLifecycleErrors,
			false
		>
	> = await requestAgentLifecycle<false>({
		client,
		path: { agentId },
		headers: { "Idempotency-Key": idempotencyKey },
		body: { schemaVersion: 1, command },
		responseStyle: "fields",
		throwOnError: false,
	});
	if (!result.data) throw requestError(result.error?.retryable !== false);
	if (result.data.agentId !== agentId) throw requestError(false);

	return result.data;
}
