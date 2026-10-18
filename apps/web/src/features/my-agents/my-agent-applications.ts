import { pilotBrowserHttpOpenApiPathsV2 } from "@agent-infra/contracts/pilot";
import type { ChipTone } from "@/lib/status-tone";
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
import {
	type CollectionReadUnavailable,
	collectionReadFailure,
} from "../collection-read-failure.js";

type UnavailableState = CollectionReadUnavailable;

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
	edit: "修改申请",
	resubmit: "修改并重新提交",
};

export function getAgentApplicationEditAction(
	application: AgentApplicationProjectionV2,
) {
	return agentApplicationEditActionByStatus[application.status];
}

export function hasCreatedAgent(
	application: AgentApplicationProjectionV2,
): application is AgentApplicationProjectionV2 & { agentId: string } {
	// An application can reserve an Agent ID before approval starts creation.
	return (
		application.agentId !== null &&
		(application.status === "creating" ||
			application.status === "available" ||
			application.status === "stopped" ||
			application.status === "creation_failed" ||
			application.status === "disabled")
	);
}

export type ApplicationProgressStepKey = "submitted" | "approval" | "creation";
export type ApplicationProgressStep = {
	key: ApplicationProgressStepKey;
	title: string;
	label: string;
	tone: ChipTone;
};

const approvalStep = {
	waiting: { label: "等待", tone: "gray" },
	withdrawn: { label: "不再审批", tone: "gray" },
	rejected: { label: "已驳回", tone: "red" },
	approved: { label: "已通过", tone: "green" },
} as const satisfies Record<
	string,
	Pick<ApplicationProgressStep, "label" | "tone">
>;

const creationStep = {
	waiting: { label: "等待", tone: "gray" },
	cancelled: { label: "不再创建", tone: "gray" },
	creating: { label: "处理中", tone: "amber" },
	done: { label: "完成", tone: "green" },
	failed: { label: "失败", tone: "red" },
	disabled: { label: "已停用", tone: "gray" },
} as const satisfies Record<
	string,
	Pick<ApplicationProgressStep, "label" | "tone">
>;

// 每个申请状态对应「系统管理员审批」「创建 Agent」两步的结果；首步提交总是完成。
// 只按申请状态判断，不用 agentId 是否存在推断（创建中、创建失败也会带 agentId）。
const progressByStatus = {
	pending_approval: [approvalStep.waiting, creationStep.waiting],
	withdrawn: [approvalStep.withdrawn, creationStep.cancelled],
	rejected: [approvalStep.rejected, creationStep.cancelled],
	creating: [approvalStep.approved, creationStep.creating],
	available: [approvalStep.approved, creationStep.done],
	stopped: [approvalStep.approved, creationStep.done],
	creation_failed: [approvalStep.approved, creationStep.failed],
	disabled: [approvalStep.approved, creationStep.disabled],
} satisfies Record<
	AgentApplicationProjectionV2["status"],
	readonly [
		Pick<ApplicationProgressStep, "label" | "tone">,
		Pick<ApplicationProgressStep, "label" | "tone">,
	]
>;

/** 申请详情的三步进度：申请已提交 → 系统管理员审批 → 创建 Agent。 */
export function applicationProgressSteps(
	status: AgentApplicationProjectionV2["status"],
): readonly ApplicationProgressStep[] {
	const [approval, creation] = progressByStatus[status];
	return [
		{ key: "submitted", title: "申请已提交", label: "完成", tone: "green" },
		{ key: "approval", title: "系统管理员审批", ...approval },
		{ key: "creation", title: "创建 Agent", ...creation },
	];
}

function requestError(input: { retryable?: boolean; code?: string } = {}) {
	return Object.assign(new Error("My Agent data is temporarily unavailable"), {
		code: input.code,
		retryable: input.retryable !== false,
	});
}

export function isRetryableMyAgentApplicationError(error: unknown): boolean {
	return (
		error instanceof Error &&
		(!("retryable" in error) || error.retryable === true)
	);
}

const retryableError = () => requestError();
const maximumMyAgentApplicationPages = 100;
const applicationPageSchema =
	pilotBrowserHttpOpenApiPathsV2["/api/v2/agent-applications"].get.responses[
		"200"
	].content["application/json"].schema;

function unavailable(
	error:
		| { retryable?: boolean; reason?: CollectionReadUnavailable["reason"] }
		| undefined,
) {
	if (error?.retryable !== false) throw retryableError();

	return {
		kind: "unavailable" as const,
		retryable: false,
		...(error?.reason ? { reason: error.reason } : {}),
	};
}

export async function loadMyAgentApplications(
	client?: Client,
	signal?: AbortSignal,
): Promise<MyAgentApplicationsState> {
	const applications: AgentApplicationProjectionV2[] = [];
	const cursors = new Set<string>();
	let cursor: string | null = null;
	let pages = 0;

	do {
		signal?.throwIfAborted();
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
			signal,
			responseStyle: "fields",
			throwOnError: false,
		});
		signal?.throwIfAborted();
		const status = result.response?.status;
		if (status !== 200) return unavailable(collectionReadFailure(status));
		if (!result.data || !applicationPageSchema.safeParse(result.data).success)
			return unavailable({ retryable: false, reason: "invalid-response" });

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
	if (!result.data) {
		throw requestError({
			code: result.error?.code,
			retryable: result.error?.retryable,
		});
	}

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
	if (!result.data) {
		throw requestError({
			code: result.error?.code,
			retryable: result.error?.retryable,
		});
	}
	if (result.data.applicationId !== applicationId)
		throw requestError({ retryable: false });

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
	if (!result.data) throw requestError(result.error ?? {});

	return result.data;
}
