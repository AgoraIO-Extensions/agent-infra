import { getCurrentSession } from "../../pilot/generated/sdk.gen.js";
import type {
	AgentLifecycleCommandRequestV1,
	ApprovalDecisionRequestV1,
	BrowserSessionProjectionV1,
	GetCurrentSessionErrors,
	GetCurrentSessionResponses,
} from "../../pilot/generated/types.gen.js";
import type {
	Client,
	RequestResult,
} from "../../pilot/generated-v2/client/index.js";
import {
	listPendingAgentApplicationsV2,
	commandAgentLifecycleV2 as requestAgentLifecycle,
	decideAgentApplicationV2 as requestApplicationDecision,
} from "../../pilot/generated-v2/sdk.gen.js";
import type {
	AgentApplicationProjectionV2,
	AgentProjectionV2,
	CommandAgentLifecycleV2Errors,
	CommandAgentLifecycleV2Responses,
	DecideAgentApplicationV2Errors,
	DecideAgentApplicationV2Responses,
	ListPendingAgentApplicationsV2Data,
	ListPendingAgentApplicationsV2Errors,
	ListPendingAgentApplicationsV2Responses,
} from "../../pilot/generated-v2/types.gen.js";

type UnavailableState = {
	kind: "unavailable";
	retryable: boolean;
};

export type PendingAgentApplicationsState =
	| { kind: "ready"; applications: AgentApplicationProjectionV2[] }
	| UnavailableState;

export type BrowserSessionState =
	| {
			kind: "ready";
			session: BrowserSessionProjectionV1;
			sessionGeneration?: string;
	  }
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
	const generation = result.response?.headers.get(
		"x-platform-session-generation",
	);
	return result.data
		? {
				kind: "ready",
				session: result.data,
				...(generation && /^[A-Za-z0-9_-]{43}$/.test(generation)
					? { sessionGeneration: generation }
					: {}),
			}
		: unavailable(result.error);
}

export async function loadPendingAgentApplications(
	client?: Client,
): Promise<PendingAgentApplicationsState> {
	const applications: AgentApplicationProjectionV2[] = [];
	const cursors = new Set<string>();
	let cursor: string | null = null;
	let pages = 0;

	do {
		if (pages >= maximumPendingApplicationPages) throw retryableError();
		pages += 1;
		const query: ListPendingAgentApplicationsV2Data["query"] =
			cursor === null ? undefined : { cursor };
		const result: Awaited<
			RequestResult<
				ListPendingAgentApplicationsV2Responses,
				ListPendingAgentApplicationsV2Errors,
				false
			>
		> = await listPendingAgentApplicationsV2<false>({
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
): Promise<AgentApplicationProjectionV2> {
	const result: Awaited<
		RequestResult<
			DecideAgentApplicationV2Responses,
			DecideAgentApplicationV2Errors,
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
): Promise<AgentProjectionV2> {
	const result: Awaited<
		RequestResult<
			CommandAgentLifecycleV2Responses,
			CommandAgentLifecycleV2Errors,
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
