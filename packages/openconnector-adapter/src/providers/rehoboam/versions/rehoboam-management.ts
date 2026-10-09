import type { ActionDefinition } from "@agent-infra/connection-core";

const id = {
	type: "string",
	minLength: 1,
	maxLength: 128,
	pattern: "^(?!\\.{1,2}$)[^/\\\\\\s]+$",
} as const;
const text = (maximum: number) => ({ type: "string", maxLength: maximum });
const strings = {
	type: "array",
	maxItems: 100,
	items: { type: "string", minLength: 1, maxLength: 256 },
} as const;
const record = { type: "object", maxProperties: 100 } as const;
const records = { type: "array", maxItems: 128, items: record } as const;
const object = (
	properties: Record<string, unknown>,
	required: string[] = [],
) => ({
	type: "object",
	additionalProperties: false,
	maxProperties: 100,
	properties,
	required,
});
const releaseChanges = object({
	title: { ...text(256), minLength: 1 },
	version: { ...text(128), minLength: 1 },
	base_version: text(128),
	base_branch: { ...text(256), minLength: 1 },
	target_branch: { ...text(256), minLength: 1 },
	request_user: { ...text(256), minLength: 1 },
	description: text(4000),
	jira_id: { ...text(128), minLength: 1 },
	template_id: id,
	cc_email_list: strings,
	other_email_list: strings,
	tester_email_list: strings,
	related_joint_publish_history_ids: {
		type: "array",
		maxItems: 100,
		items: id,
	},
	native_publish_marker_config_ids: { type: "array", maxItems: 100, items: id },
	customer_config_id: { anyOf: [id, { type: "null" }] },
	test_plan: { anyOf: [text(4000), { type: "null" }] },
	test_issues: { anyOf: [text(4000), { type: "null" }] },
});
const pipelineConfiguration = object({
	pipeline_name: { ...text(256), minLength: 1 },
	pipeline_url: { ...text(1024), minLength: 1 },
	pipeline_type: text(128),
	pipeline_type_preset: {
		type: "string",
		enum: ["", "compile", "release", "git_operate", "security_audit"],
	},
	repo_url: text(1024),
	admin_email_list: strings,
	operator_email_list: strings,
	job_params_list: records,
	job_result_reg: text(4000),
	jira_customfields: records,
});
const templateConfiguration = object({
	name: { ...text(256), minLength: 1 },
	description: text(4000),
	main_repo_url: text(1024),
	tags: strings,
	cards: { ...records, maxItems: 64 },
	connections: records,
	release_family_config: { anyOf: [record, { type: "null" }] },
	notification_templates: record,
	test_jira_prefills: record,
	diff_repo_url: text(1024),
	diff_preset_paths: strings,
	diff_content_regex: records,
	release_flow_nodes: records,
	release_flow_connections: records,
	preset_cc_email_list: strings,
	preset_other_email_list: strings,
});
const requestChanges = object({
	params: record,
	upstream_result: {
		anyOf: [
			object(
				{
					card_id: id,
					result_index: { type: "integer", minimum: 0, maximum: 199 },
				},
				["card_id", "result_index"],
			),
			{ type: "null" },
		],
	},
	execution_mode: {
		type: "string",
		enum: ["auto_after_approval", "manual_after_approval", "scheduled"],
	},
	scheduled_run_time: {
		anyOf: [
			{ type: "integer", minimum: 1, maximum: 9007199254740991 },
			{ type: "null" },
		],
	},
});
const confirmation = {
	previewId: id,
	confirmationToken: { type: "string", minLength: 1, maxLength: 128 },
};
const pagination = {
	page: { type: "integer", minimum: 1, maximum: 10000 },
	pageSize: { type: "integer", minimum: 1, maximum: 50 },
	name: text(256),
};
const timelinePagination = {
	offset: { type: "integer", minimum: 0, maximum: 10000 },
	pageSize: pagination.pageSize,
};

type Specification = {
	name: string;
	description: string;
	effect: "READ" | "WRITE";
	path: (input: Record<string, unknown>) => string;
	properties: Record<string, unknown>;
	required: string[];
	metadata?: boolean;
	query?: Record<string, string>;
	body?: "changes" | "configuration" | "confirmation";
};
const requiredId = (input: Record<string, unknown>, field: string) => {
	const value = input[field];
	if (
		typeof value !== "string" ||
		!new RegExp(id.pattern).test(value) ||
		value.length > 128
	)
		throw new Error(`Invalid management resource field: ${field}`);
	return encodeURIComponent(value);
};
const definitions: Specification[] = [];
const add = (definition: Specification) => definitions.push(definition);

for (const [kind, prefix, field, schema, label] of [
	["release", "/mcp/v1/releases", "releaseId", releaseChanges, "版本详情"],
	[
		"template",
		"/mcp/v1/template-configurations",
		"templateId",
		templateConfiguration,
		"模板配置（仅管理员）",
	],
	[
		"pipeline",
		"/mcp/v1/pipeline-definitions",
		"pipelineId",
		pipelineConfiguration,
		"流水线配置（仅管理员）",
	],
] as const) {
	for (const operation of kind === "release"
		? ["update", "copy"]
		: ["create", "update", "copy"]) {
		const selector = operation === "create" ? {} : { [field]: id };
		const selectedFields = operation === "create" ? [] : [field];
		const prefixFor = (input: Record<string, unknown>) =>
			operation === "create" ? prefix : `${prefix}/${requiredId(input, field)}`;
		const body = kind === "release" ? "changes" : "configuration";
		add({
			name: `preview_${operation}_${kind}`,
			description: `保存${label}${operation}预览；不运行Job、不发送通知。`,
			effect: "WRITE",
			path: (input) => `${prefixFor(input)}/connection-${operation}-preview`,
			properties: { ...selector, [body]: { ...schema, minProperties: 1 } },
			required: [...selectedFields, body],
			body,
		});
		add({
			name: `${operation}_${kind}`,
			description: `确认本人${label}${operation}预览；冻结字段与当前资源校验，未知结果不重试。`,
			effect: "WRITE",
			path: (input) => `${prefixFor(input)}/connection-${operation}-confirm`,
			properties: { ...selector, ...confirmation },
			required: [...selectedFields, "previewId", "confirmationToken"],
			body: "confirmation",
		});
	}
}
for (const [kind, prefix, field, label] of [
	[
		"pipeline_definitions",
		"/mcp/v1/pipeline-definitions",
		"pipelineId",
		"全局流水线定义",
	],
	[
		"customer_configs",
		"/mcp/v1/customer-config-definitions",
		"customerConfigId",
		"客户配置",
	],
	[
		"native_publish_marker_configs",
		"/mcp/v1/native-publish-marker-definitions",
		"markerConfigId",
		"Native发布标记",
	],
] as const) {
	const filters =
		kind === "pipeline_definitions"
			? { pipelineType: text(128) }
			: kind === "customer_configs"
				? { vid: text(256) }
				: {};
	add({
		name: `list_${kind}`,
		description: `分页查询${label}，不返回内部Prompt或凭据。`,
		effect: "READ",
		metadata: true,
		path: () => prefix,
		properties: { ...pagination, ...filters },
		required: [],
		query: {
			page: "page",
			pageSize: "page_size",
			name: "name",
			pipelineType: "pipeline_type",
			vid: "vid",
		},
	});
	add({
		name: `get_${kind === "pipeline_definitions" ? "pipeline_definition" : kind.slice(0, -1)}`,
		description: `读取${label}；完整流水线配置仅管理员可读，敏感字段显式省略。`,
		effect: "READ",
		metadata: true,
		path: (input) => `${prefix}/${requiredId(input, field)}`,
		properties: { [field]: id },
		required: [field],
	});
}
add({
	name: "get_template_configuration",
	description: "读取可编辑模板配置，仅管理员可读；不返回内部Prompt或凭据。",
	effect: "READ",
	metadata: true,
	path: (input) =>
		`/mcp/v1/template-configurations/${requiredId(input, "templateId")}`,
	properties: { templateId: id },
	required: ["templateId"],
});
add({
	name: "get_release_operation",
	description: "只读查询本人创建或管理操作回执；不再次提交，不返回确认凭据。",
	effect: "READ",
	path: (input) =>
		`/mcp/v1/management-operations/${requiredId(input, "previewId")}`,
	properties: { previewId: id },
	required: ["previewId"],
});
add({
	name: "get_release_timeline",
	description: "有界分页读取版本流程记录；单条内容截断会标记。",
	effect: "READ",
	path: (input) =>
		`/mcp/v1/releases/${requiredId(input, "releaseId")}/timeline`,
	properties: { releaseId: id, ...timelinePagination },
	required: ["releaseId"],
	query: { offset: "offset", pageSize: "page_size" },
});
const requestPrefix = (input: Record<string, unknown>) =>
	`/mcp/v1/releases/${requiredId(input, "releaseId")}/execution-requests/${requiredId(input, "requestId")}`;
add({
	name: "get_execution_request_timeline",
	description: "有界读取版本内的申请时间线；仅申请人、当前审批人或管理员可读。",
	effect: "READ",
	path: (input) => `${requestPrefix(input)}/timeline`,
	properties: { releaseId: id, requestId: id, ...timelinePagination },
	required: ["releaseId", "requestId"],
	query: { offset: "offset", pageSize: "page_size" },
});
add({
	name: "preview_update_execution_request",
	description:
		"预览本人被拒绝/撤回申请的编辑重提，展示当前审批人与通知影响；不运行Job。",
	effect: "WRITE",
	path: (input) => `${requestPrefix(input)}/connection-update-preview`,
	properties: {
		releaseId: id,
		requestId: id,
		changes: { ...requestChanges, minProperties: 1 },
	},
	required: ["releaseId", "requestId", "changes"],
	body: "changes",
});
add({
	name: "update_execution_request",
	description:
		"确认本人申请编辑重提；沿用原审批和定时规则，会通知当前审批人，未知结果不重发。",
	effect: "WRITE",
	path: (input) => `${requestPrefix(input)}/connection-update-confirm`,
	properties: { releaseId: id, requestId: id, ...confirmation },
	required: ["releaseId", "requestId", "previewId", "confirmationToken"],
	body: "confirmation",
});

export const rehoboamManagementActions: ActionDefinition[] = definitions.map(
	(definition) => ({
		name: `rehoboam.${definition.name}`,
		id: `rehoboam.${definition.name}@v11`,
		description: definition.description,
		effect: definition.effect,
		requiredScopes: [
			definition.effect === "WRITE"
				? "rehoboam.release.write"
				: definition.metadata
					? "rehoboam.metadata.read"
					: "rehoboam.release.read",
		],
		inputSchema: object(
			{
				...definition.properties,
				...(definition.effect === "WRITE" ? { idempotencyKey: id } : {}),
			},
			[
				...definition.required,
				...(definition.effect === "WRITE" ? ["idempotencyKey"] : []),
			],
		),
	}),
);

export function managementRequest(
	action: string,
	input: Record<string, unknown>,
): { path: string; init: RequestInit } {
	const definition = definitions.find(
		(item) => `rehoboam.${item.name}` === action,
	);
	if (!definition) throw new Error("Unsupported Rehoboam management Action");
	let path = definition.path(input);
	if (definition.query) {
		const query = new URLSearchParams();
		for (const [key, wireKey] of Object.entries(definition.query)) {
			if (key in definition.properties && input[key] !== undefined)
				query.set(wireKey, String(input[key]));
		}
		if (query.size) path += `?${query}`;
	}
	if (!definition.body) return { path, init: { method: "GET" } };
	const body =
		definition.body === "confirmation"
			? {
					preview_id: input.previewId,
					confirmation_token: input.confirmationToken,
				}
			: input[definition.body];
	return {
		path,
		init: {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		},
	};
}
