import { createHash } from "node:crypto";
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
	timeline: Array<{ event: string; occurredAt: string }>;
};
export type AuditRawDetail = AuditCall & {
	requestInput: unknown;
	result: unknown;
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
	"pullNumber",
	"pull_number",
	"limit",
	"maxResults",
	"number",
	"total",
]);
const knownActions = new Set([
	"jira.get_issue",
	"jira.create_issue",
	"jira.add_comment",
	"jira.update_issue",
	"jira.delete_issue",
	"jira.search_issues",
	"jira.list_projects",
	"github.list_pull_requests",
	"github.get_pull_request",
	"github.create_pull_request",
	"github.list_issues",
	"github.get_issue",
	"github.create_issue",
	"confluence.get_page",
	"confluence.create_page",
	"confluence.update_page",
]);
function summarize(action: string, value: unknown): AuditField[] {
	if (
		!knownActions.has(action) ||
		!value ||
		typeof value !== "object" ||
		Array.isArray(value)
	)
		return [];
	const object = value as Record<string, unknown>;
	return Object.entries(labels)
		.filter(([key]) => Object.hasOwn(object, key))
		.map(([key, label]) => {
			const field = object[key];
			if (
				numeric.has(key) &&
				typeof field === "number" &&
				Number.isSafeInteger(field) &&
				field >= 0
			)
				return { label, value: String(field), state: "AVAILABLE" as const };
			if (
				(key === "key" || key === "issueIdOrKey") &&
				action.startsWith("jira.") &&
				typeof field === "string" &&
				/^[A-Z][A-Z0-9]{0,15}-[1-9][0-9]{0,12}$/.test(field)
			)
				return { label, value: field, state: "AVAILABLE" as const };
			return { label, value: "已脱敏", state: "REDACTED" as const };
		});
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
	return {
		...projectAuditCall(raw),
		input: summarize(raw.action, raw.requestInput),
		output: summarize(raw.action, raw.result),
		timeline: raw.timeline.map(({ event, occurredAt }) => ({
			event,
			occurredAt,
		})),
	};
}
