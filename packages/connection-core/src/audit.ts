import { createHash } from "node:crypto";
import {
	type CallDiagnostics,
	projectCallDiagnostics,
} from "./call-diagnostics";
import { type CallStatus, ConnectionError } from "./index";

export type AuditQuery = {
	from: string;
	to: string;
	query?: string;
	status?: CallStatus;
	cursor?: string;
};
export type AuditFilter = AuditQuery & {
	binding: string;
	after?: { createdAt: string; callId: string };
};
export type AuditCall = {
	callId: string;
	createdAt: string;
	principalId: string;
	person: string;
	email: string | null;
	consumerId: string;
	consumer: string;
	instanceId: string;
	actorKey: string | null;
	connectionId: string;
	providerId: string;
	action: string;
	actionVersionId: string;
	status: CallStatus;
};
export type AuditField = {
	label: string;
	value: string;
	state: "AVAILABLE" | "REDACTED";
};
export type AuditDetail = AuditCall & {
	input: AuditField[];
	output: AuditField[];
	inputState: AuditSummaryState;
	outputState: AuditSummaryState;
	diagnostics: CallDiagnostics[];
	diagnosticsTruncated: boolean;
	timeline: Array<{ event: string; occurredAt: string }>;
};
export type AuditSummaryState =
	| "AVAILABLE"
	| "REDACTED"
	| "NO_PARAMETERS"
	| "EMPTY_INPUT"
	| "EMPTY_OUTPUT"
	| "UNSUPPORTED"
	| "NOT_RECORDED";
export type AuditRawDetail = AuditCall & {
	requestInput: unknown;
	result: unknown;
	inputSchema?: unknown;
	diagnosticRecords?: unknown[];
	diagnosticsTruncated?: boolean;
	timeline: AuditDetail["timeline"];
};
export type AuditPage = { items: AuditCall[]; nextCursor: string | null };
const statuses = new Set([
	"AUTHORIZED",
	"DENIED_LOCAL",
	"SUCCEEDED",
	"FAILED",
	"UNCERTAIN",
]);
function invalid(): never {
	throw new ConnectionError("INVALID_REQUEST", "Invalid audit query");
}
function iso(value: unknown): value is string {
	return (
		typeof value === "string" &&
		/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/.test(value) &&
		Number.isFinite(Date.parse(value))
	);
}
export function auditFilter(
	principalId: string,
	input: AuditQuery,
): AuditFilter {
	if (
		!iso(input.from) ||
		!iso(input.to) ||
		Date.parse(input.to) <= Date.parse(input.from) ||
		Date.parse(input.to) - Date.parse(input.from) > 93 * 86_400_000
	)
		invalid();
	if (
		input.query !== undefined &&
		(typeof input.query !== "string" || input.query.length > 120)
	)
		invalid();
	if (input.status !== undefined && !statuses.has(input.status)) invalid();
	const query = input.query?.trim() ?? "";
	const binding = createHash("sha256")
		.update(
			JSON.stringify([
				principalId,
				input.from,
				input.to,
				query,
				input.status ?? "",
			]),
		)
		.digest("hex");
	let after: AuditFilter["after"];
	if (input.cursor !== undefined) {
		if (typeof input.cursor !== "string" || input.cursor.length > 2048)
			invalid();
		try {
			const decoded = JSON.parse(
				Buffer.from(input.cursor, "base64url").toString("utf8"),
			);
			if (
				decoded.binding !== binding ||
				!iso(decoded.createdAt) ||
				typeof decoded.callId !== "string" ||
				!decoded.callId ||
				decoded.callId.length > 512
			)
				invalid();
			after = { createdAt: decoded.createdAt, callId: decoded.callId };
		} catch {
			invalid();
		}
	}
	return { ...input, query, binding, after };
}
export function auditPage(items: AuditCall[], binding: string): AuditPage {
	const page = items.slice(0, 50).map(projectAuditCall);
	const last = page.at(-1);
	return {
		items: page,
		nextCursor:
			items.length > 50 && last
				? Buffer.from(
						JSON.stringify({
							binding,
							createdAt: last.createdAt,
							callId: last.callId,
						}),
					).toString("base64url")
				: null,
	};
}

// Only fixed scalar policies are exposed. Never echo arbitrary keys, text or URLs.
const labels: Record<string, string> = {
	displayName: "账号名称",
	username: "账号名称",
	externalAccount: "外部账号指纹",
	login: "账号名称",
	name: "名称",
	title: "标题",
	url: "对象地址",
	jobName: "任务名称",
	buildNumber: "构建编号",
	buildId: "构建编号",
	projectId: "项目编号",
	projectKeyOrId: "项目编号",
	repositorySlug: "仓库",
	pullRequestId: "合并请求编号",
	issueKey: "工单编号",
	issueId: "工单编号",
	spaceKey: "文档空间",
	pageTitle: "文档标题",
	content: "内容",
	text: "正文",
	query: "查询条件",
	jql: "查询条件",
	sql: "查询语句",
	releaseId: "发布编号",
	pipelineId: "流水线编号",
	executionId: "执行编号",
	queryId: "查询编号",
	symbolId: "符号编号",
	dumpId: "Dump 编号",
	status: "状态",
	count: "结果数量",
	size: "结果数量",
	page: "页码",
	pageSize: "每页条数",
	projectKey: "项目编号",
	issueIdOrKey: "工单编号",
	issueTypeName: "工单类型",
	summary: "标题",
	description: "描述",
	body: "正文",
	comment: "评论内容",
	owner: "仓库所有者",
	repo: "仓库",
	repository: "仓库",
	project: "项目",
	pullNumber: "合并请求编号",
	pull_number: "合并请求编号",
	pageId: "页面编号",
	limit: "返回条数",
	maxResults: "返回条数",
	state: "状态",
	key: "工单编号",
	id: "对象编号",
	number: "编号",
	total: "结果数量",
};
const numeric = new Set([
	"buildNumber",
	"count",
	"size",
	"page",
	"pageSize",
	"pullRequestId",
	"pullNumber",
	"pull_number",
	"limit",
	"maxResults",
	"number",
	"total",
]);
const collectionLabels: Record<string, string> = {
	values: "结果条数",
	items: "结果条数",
	results: "结果条数",
	pull_requests: "合并请求数量",
	issues: "工单数量",
	projects: "项目数量",
	repositories: "仓库数量",
	comments: "评论数量",
	builds: "构建数量",
	jobs: "任务数量",
	releases: "发布数量",
	pipelines: "流水线数量",
	symbols: "符号数量",
	dumps: "Dump 数量",
	grantedScopes: "授权范围数量",
};
function record(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}
function summarize(
	action: string,
	value: unknown,
	input: boolean,
	schema?: unknown,
): { fields: AuditField[]; state: AuditSummaryState } {
	if (value === null || value === undefined)
		return { fields: [], state: "NOT_RECORDED" };
	if (Array.isArray(value))
		return {
			fields: [
				{ label: "结果条数", value: String(value.length), state: "AVAILABLE" },
			],
			state: "AVAILABLE",
		};
	let object = record(value);
	if (!object) return { fields: [], state: "UNSUPPORTED" };
	const keys = Object.keys(object).filter((key) => key !== "idempotencyKey");
	if (!keys.length) {
		if (!input) return { fields: [], state: "EMPTY_OUTPUT" };
		const definition = record(schema);
		const properties = record(definition?.properties);
		if (!properties || !Array.isArray(definition?.required))
			return { fields: [], state: "NOT_RECORDED" };
		return {
			fields: [],
			state:
				Object.keys(properties).filter((key) => key !== "idempotencyKey")
					.length === 0
					? "NO_PARAMETERS"
					: definition.required.filter((key) => key !== "idempotencyKey")
								.length === 0
						? "EMPTY_INPUT"
						: "NOT_RECORDED",
		};
	}
	// Recognize bounded envelopes without traversing or copying arbitrary Provider payloads.
	if (!input)
		for (let depth = 0; depth < 2; depth++) {
			let unwrapped = false;
			for (const wrapper of [
				"data",
				"result",
				"user",
				"account",
				"profile",
				"repository",
				"space",
				"page",
				"issue",
				"pull_request",
				"release",
				"pipeline",
				"execution",
			]) {
				if (Array.isArray(object[wrapper]))
					return {
						fields: [
							{
								label: "结果条数",
								value: String(object[wrapper].length),
								state: "AVAILABLE",
							},
						],
						state: "AVAILABLE",
					};
				const nested = record(object[wrapper]);
				if (nested) {
					object = nested;
					unwrapped = true;
					break;
				}
			}
			if (!unwrapped) break;
		}
	const fields: AuditField[] = Object.entries(labels)
		.filter(([key]) => Object.hasOwn(object, key))
		.map(([key, label]) => {
			const field = object[key];
			if (
				!input &&
				key === "externalAccount" &&
				typeof field === "string" &&
				field.length <= 512
			)
				return {
					label,
					value: createHash("sha256").update(field).digest("hex").slice(0, 12),
					state: "REDACTED" as const,
				};
			if (
				numeric.has(key) &&
				typeof field === "number" &&
				Number.isSafeInteger(field) &&
				field >= 0
			)
				return { label, value: String(field), state: "AVAILABLE" as const };
			if (
				(key === "key" || key === "issueIdOrKey" || key === "issueKey") &&
				action.startsWith("jira.") &&
				typeof field === "string" &&
				/^[A-Z][A-Z0-9]{0,15}-[1-9][0-9]{0,12}$/.test(field)
			)
				return { label, value: field, state: "AVAILABLE" as const };
			return { label, value: "已脱敏", state: "REDACTED" as const };
		});
	if (!input)
		for (const [key, label] of Object.entries(collectionLabels))
			if (Array.isArray(object[key]))
				fields.push({
					label,
					value: String(object[key].length),
					state: "AVAILABLE",
				});
	if (!fields.length) return { fields: [], state: "UNSUPPORTED" };
	return {
		fields,
		state: fields.some((field) => field.state === "REDACTED")
			? "REDACTED"
			: "AVAILABLE",
	};
}
function projectAuditCall(raw: AuditCall): AuditCall {
	return {
		callId: raw.callId,
		createdAt: raw.createdAt,
		principalId: raw.principalId,
		person: raw.person,
		email: raw.email,
		consumerId: raw.consumerId,
		consumer: raw.consumer,
		instanceId: raw.instanceId,
		actorKey: raw.actorKey,
		connectionId: raw.connectionId,
		providerId: raw.providerId,
		action: raw.action,
		actionVersionId: raw.actionVersionId,
		status: raw.status,
	};
}
export function projectAuditDetail(raw: AuditRawDetail): AuditDetail {
	const input = summarize(raw.action, raw.requestInput, true, raw.inputSchema);
	const output = summarize(raw.action, raw.result, false);
	return {
		...projectAuditCall(raw),
		input: input.fields,
		output: output.fields,
		inputState: input.state,
		outputState: output.state,
		diagnostics: (raw.diagnosticRecords ?? [])
			.map(projectCallDiagnostics)
			.filter((value): value is CallDiagnostics => value !== null),
		diagnosticsTruncated: raw.diagnosticsTruncated === true,
		timeline: raw.timeline.map(({ event, occurredAt }) => ({
			event,
			occurredAt,
		})),
	};
}
