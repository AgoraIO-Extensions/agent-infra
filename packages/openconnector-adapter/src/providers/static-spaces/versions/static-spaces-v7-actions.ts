import { createHash } from "node:crypto";
import type { Schema } from "@cfworker/json-schema";
export type ActionSpec = {
	name: string;
	description: string;
	effect: "READ" | "WRITE";
	path: string;
	method?: string;
	properties: Record<string, Schema>;
	required: readonly string[];
};
const text: Schema = { type: "string", minLength: 1, maxLength: 8192 };
const name: Schema = {
	type: "string",
	pattern: "^[A-Za-z0-9@][A-Za-z0-9._@+-]{0,254}$",
};
const slug: Schema = { type: "string", pattern: "^[a-z0-9][a-z0-9._-]{0,62}$" };
const boolean: Schema = { type: "boolean" };
const integer: Schema = { type: "integer", minimum: 0 };
const pk: Schema = { type: ["string", "integer"] };
const hash: Schema = { type: "string", pattern: "^[a-f0-9]{64}$" };
const strings: Schema = {
	type: "array",
	items: text,
	maxItems: 100,
	uniqueItems: true,
};
const array = (items: Schema): Schema => ({
	type: "array",
	items,
	maxItems: 10000,
});
const object = (
	properties: Record<string, Schema>,
	required = Object.keys(properties),
): Schema => ({
	type: "object",
	additionalProperties: false,
	properties,
	required,
});
const target = {
	kind: { enum: ["user", "shared", "public"] },
	slug,
	username: name,
};
const shared = { kind: { const: "shared" }, slug };
const path: Schema = { type: "string", minLength: 1, maxLength: 512 };
const doc = { ...target, path };
const change = { action: { enum: ["add", "remove"] } };
const scope = {
	space: text,
	kind: { enum: ["user", "shared", "public"] },
	slug: text,
	path_prefix: text,
	url_prefix: text,
};
const membership = object({ username: text, group: text, member: boolean });
const group = object({ pk, name: text, is_superuser: { const: false } });
const directory = object({
	name: text,
	display_name: text,
	path: { type: "string" },
	member_count: { type: ["integer", "null"], minimum: 0 },
	directory_uid: text,
});
const acl = object(
	{
		id: pk,
		prefix: text,
		groups: {
			type: ["string", "array"],
			items: text,
			maxItems: 100,
			maxLength: 8192,
		},
		enabled: { enum: [true, false, 0, 1] },
		created_at: text,
	},
	["prefix", "groups", "enabled"],
);
const removed = object(
	{
		deleted: boolean,
		prefix: text,
		path_prefix: text,
		slug: text,
		group: text,
		name: text,
		pk,
		reason: text,
		rule_ids: array(pk),
		bindings_deleted: array(pk),
	},
	["deleted"],
);
const nullableTime: Schema = { type: ["string", "null"], maxLength: 128 };
const comment = object({
	id: text,
	author_email: text,
	body: { type: "string", maxLength: 10000 },
	created_at: text,
	edited_at: nullableTime,
	deleted_at: nullableTime,
	can_edit: boolean,
	can_delete: boolean,
});
const anchor = object(
	{
		type: { enum: ["document", "selection"] },
		document_sha256: hash,
		strategy: { const: "source-lines" },
		start_line: { type: "integer", minimum: 1 },
		end_line: { type: "integer", minimum: 1 },
		quote: { type: "string", minLength: 1, maxLength: 4000 },
	},
	["type", "document_sha256"],
);
const binding = object(
	{ pk, target: pk, group: pk, enabled: boolean, negate: boolean },
	["target", "group", "enabled", "negate"],
);
export const subscriptionWarnings: Schema = array(
	object(
		{
			code: text,
			message: text,
			id: { type: "string" },
			path: text,
			block_id: { type: "string" },
		},
		["code"],
	),
);
const spec = (
	name: string,
	effect: "READ" | "WRITE",
	path: string,
	properties: Record<string, Schema>,
	required: string[],
	description: string,
	method?: string,
): ActionSpec => ({
	name,
	effect,
	path,
	properties,
	required,
	description,
	method,
});
export const extraSpecs: ActionSpec[] = [
	spec(
		"search_directory_groups",
		"READ",
		"/v1/directory-groups",
		{
			query: { type: "string", maxLength: 256 },
			limit: { type: "integer", minimum: 1, maximum: 100 },
		},
		[],
		"搜索可授予读取权限的目录同步组织组；不返回成员列表。确认唯一组及当前/未来成员范围后授权。",
	),
	spec(
		"manage_shared_membership",
		"WRITE",
		"/v1/shared-memberships",
		{
			...shared,
			...change,
			username: name,
			emails: {
				type: "array",
				items: { type: "string", format: "email", maxLength: 254 },
				minItems: 1,
				maxItems: 100,
				uniqueItems: true,
			},
			role: { enum: ["owner", "manager", "viewer"] },
		},
		["kind", "slug", "role", "action"],
		"管理明确 shared 空间的成员。owner 管全部角色，manager 仅 viewer；邮箱批量只支持 viewer。操作前确认目标/角色/增删，授权覆盖整个空间；最后 owner 保护由上游执行。",
	),
	spec(
		"manage_shared_group_grant",
		"WRITE",
		"/v1/shared-group-grants",
		{ ...shared, ...change, group: name, role: { const: "viewer" } },
		["kind", "slug", "group", "role", "action"],
		"授予/撤销已确认的目录组整个 shared 空间读取权，影响当前及未来成员；只读，不授予写权。",
	),
	spec(
		"delete_file",
		"WRITE",
		"/v1/delete-file",
		{ ...target, relative_path: path },
		["kind", "relative_path"],
		"删除明确单个文件，Markdown 评审也被清理；确认目标后执行。",
	),
	spec(
		"delete_space",
		"WRITE",
		"/v1/delete-space",
		target,
		["kind"],
		"删除整个空间及文件、评论、ACL、组和 shared 门户；仅本人或 owner/管理员，需明确确认整个空间。",
	),
	spec(
		"render_index",
		"WRITE",
		"/v1/render-index",
		{ ...target, title: text, overwrite: boolean },
		["kind"],
		"生成 HTML 目录 index.html，默认不覆盖；确认目标空间及覆盖意图。",
	),
	spec(
		"create_markdown_comment",
		"WRITE",
		"/v1/markdown-review/comments",
		{
			...doc,
			body: { type: "string", minLength: 1, maxLength: 10000 },
			document_sha256: hash,
			thread_id: name,
			anchor: object(
				{
					type: { enum: ["document", "selection"] },
					start_line: { type: "integer", minimum: 1 },
					end_line: { type: "integer", minimum: 1 },
					quote: { type: "string", minLength: 1, maxLength: 4000 },
				},
				["type"],
			),
		},
		["kind", "path", "body"],
		"用户明确要求发表评论后执行：新讨论使用当前文档 SHA 与 document/selection anchor，回复仅 thread_id；DOCUMENT_CHANGED 重新读取，不重放旧 anchor。",
	),
	spec(
		"edit_markdown_comment",
		"WRITE",
		"/v1/markdown-review/comments/{id}",
		{
			...doc,
			comment_id: name,
			body: { type: "string", minLength: 1, maxLength: 10000 },
		},
		["kind", "path", "comment_id", "body"],
		"修改本人评论；提交前读取 latest can_edit。",
		"PATCH",
	),
	spec(
		"delete_markdown_comment",
		"WRITE",
		"/v1/markdown-review/comments/{id}",
		{ ...doc, comment_id: name },
		["kind", "path", "comment_id"],
		"删除本人评论；提交前读取 latest can_delete，明确确认目标。",
		"DELETE",
	),
	spec(
		"admin_find_users",
		"READ",
		"/v1/users",
		{ username: name },
		["username"],
		"仅 StaticSpaces 管理员查询明确用户；不含凭证/属性。",
	),
	spec(
		"admin_find_groups",
		"READ",
		"/v1/groups",
		{ name },
		["name"],
		"仅 StaticSpaces 管理员查询明确组；不回传成员清单。",
	),
	spec(
		"admin_list_acl",
		"READ",
		"/v1/acl",
		{ prefix: path },
		["prefix"],
		"仅管理员查看指定空间路径相关 ACL；不改变授权。",
	),
	spec(
		"admin_ensure_group",
		"WRITE",
		"/v1/groups",
		{ name, description: text },
		["name"],
		"仅管理员创建明确组；不授予成员，不创建超级用户组。",
	),
	spec(
		"admin_manage_membership",
		"WRITE",
		"/v1/memberships",
		{ username: name, group: name, ...change },
		["username", "group", "action"],
		"仅管理员对已确认用户与组增加/移除成员；可能改变系统权限，不得顺带调用。",
	),
	spec(
		"admin_set_acl",
		"WRITE",
		"/v1/acl",
		{ prefix: path, groups: strings, enabled: boolean },
		["prefix", "groups", "enabled"],
		"仅管理员修改精确空间/内容 ACL；groups=[] 意味所有登录用户可读，禁止根路径规则。",
	),
	spec(
		"admin_check_access",
		"READ",
		"/v1/check-access",
		{ username: name, path },
		["username", "path"],
		"仅管理员检查明确用户对路径的读取资格；只读，不授予权限。",
		"POST",
	),
	spec(
		"admin_ensure_internal_user",
		"WRITE",
		"/v1/users",
		{
			username: name,
			display_name: text,
			email: { type: "string", format: "email" },
			active: boolean,
		},
		["username"],
		"仅管理员显式遗留内部账号操作；不得创建 LDAP 用户，无密码生成/重设/返回，不用于普通发布或分享。",
	),
];
export const extraOutputs: Record<string, Schema> = {
	subscriptionWarnings,
	search_directory_groups: object({ groups: array(directory) }),
	manage_shared_membership: {
		anyOf: [
			membership,
			object(
				{
					...scope,
					role: { const: "viewer" },
					action: { enum: ["add", "remove"] },
					emails: strings,
					memberships: array(membership),
				},
				["kind", "slug", "role", "action", "emails", "memberships"],
			),
		],
	},
	manage_shared_group_grant: object(
		{
			...scope,
			role: { const: "viewer" },
			action: { enum: ["add", "remove"] },
			group: directory,
			acl,
			acl_groups: strings,
			application_binding: { anyOf: [binding, removed] },
		},
		[
			"kind",
			"slug",
			"role",
			"action",
			"group",
			"acl",
			"acl_groups",
			"application_binding",
		],
	),
	delete_file: object(
		{
			...scope,
			deleted: { const: true },
			path: text,
			comments_deleted: integer,
		},
		["kind", "slug", "deleted", "path", "comments_deleted"],
	),
	delete_space: object(
		{
			...scope,
			acl: removed,
			directory: removed,
			comments_deleted: integer,
			application: { anyOf: [removed, { type: "null" }] },
			groups: array(removed),
		},
		[
			"kind",
			"slug",
			"acl",
			"directory",
			"comments_deleted",
			"application",
			"groups",
		],
	),
	render_index: object(
		{
			...scope,
			path: text,
			url: text,
			size: integer,
			sha256: hash,
			subscription_url: text,
			subscription_warnings: subscriptionWarnings,
		},
		["kind", "slug", "path", "url", "size", "sha256"],
	),
	create_markdown_comment: object({
		etag: text,
		thread: object({ id: text, anchor, comments: array(comment) }),
	}),
	edit_markdown_comment: object({ etag: text, comment }),
	delete_markdown_comment: object({
		etag: text,
		deleted: { const: true },
		thread_id: text,
		comment_id: text,
	}),
	admin_find_users: object({
		users: array(
			object(
				{
					pk,
					username: text,
					name: text,
					email: { type: "string" },
					is_active: boolean,
					is_superuser: boolean,
				},
				["pk", "username"],
			),
		),
	}),
	admin_find_groups: object({
		groups: array(
			object({ pk, name: text, is_superuser: boolean }, [
				"pk",
				"name",
				"is_superuser",
			]),
		),
	}),
	admin_list_acl: object({ rules: array(acl) }),
	admin_ensure_group: object({ created: boolean, group }),
	admin_manage_membership: membership,
	admin_set_acl: acl,
	admin_check_access: object(
		{
			username: text,
			path: text,
			allowed: boolean,
			status: { type: "integer", minimum: 100, maximum: 599 },
			matched_rule: { type: ["string", "integer", "null"] },
		},
		["username", "path", "allowed", "status"],
	),
	admin_ensure_internal_user: object({
		created: boolean,
		user: object({ pk, username: text, active: boolean }),
	}),
};
function invalid(): never {
	throw Object.assign(new Error("StaticSpaces input or result is invalid"), {
		providerCode: "invalid_input",
		providerStatus: 400,
	});
}
export function safeFullPath(value: unknown, absolute = false) {
	if (
		typeof value !== "string" ||
		!value ||
		value.length > 512 ||
		value.includes("\\") ||
		[...value].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) ||
		/%(?:2f|5c|2e|00)/i.test(value)
	)
		invalid();
	const parts = value.split("/");
	if (absolute) {
		if (
			parts.shift() !== "" ||
			parts[0] !== "spaces" ||
			!["users", "shared", "public"].includes(parts[1] ?? "") ||
			parts.length < 3
		)
			invalid();
		if (parts.at(-1) === "") parts.pop();
		if (parts.length < 3) invalid();
	}
	if (
		parts.some(
			(p) =>
				!p ||
				p === "." ||
				p === ".." ||
				p === "__staticspaces" ||
				p === "__state",
		)
	)
		invalid();
}
export function extraPayload(
	spec: ActionSpec,
	payload: Record<string, unknown>,
) {
	for (const field of ["path", "relative_path"])
		if (field in payload)
			safeFullPath(payload[field], spec.name === "admin_check_access");
	if ("prefix" in payload) {
		safeFullPath(payload.prefix, true);
		if (!String(payload.prefix).endsWith("/"))
			payload.prefix = `${payload.prefix}/`;
	}
	if (spec.name.startsWith("manage_shared_") && payload.kind !== "shared")
		invalid();
	if (spec.name === "manage_shared_membership") {
		if (
			"emails" in payload === "username" in payload ||
			("emails" in payload && payload.role !== "viewer")
		)
			invalid();
		if (Array.isArray(payload.emails)) {
			const emails = payload.emails.map((e) => String(e).trim().toLowerCase());
			if (
				emails.some((e) => !/^\S+@\S+\.\S+$/.test(e)) ||
				new Set(emails).size !== emails.length
			)
				invalid();
			payload.emails = emails;
		}
	}
	if (spec.name.includes("markdown_comment")) {
		if (!/\.(md|markdown)$/i.test(String(payload.path))) invalid();
		if (spec.name === "create_markdown_comment") {
			const reply = "thread_id" in payload;
			if (
				reply
					? "anchor" in payload || "document_sha256" in payload
					: !("anchor" in payload && "document_sha256" in payload)
			)
				invalid();
			if (!reply) {
				const a = payload.anchor as Record<string, unknown>;
				if (a.type === "document" && Object.keys(a).length !== 1) invalid();
				if (
					a.type === "selection" &&
					(!Number.isInteger(a.start_line) ||
						!Number.isInteger(a.end_line) ||
						Number(a.end_line) < Number(a.start_line) ||
						typeof a.quote !== "string" ||
						!a.quote.trim())
				)
					invalid();
			}
		}
	}
	if (spec.name === "render_index" && !("overwrite" in payload))
		payload.overwrite = false;
	if (spec.name === "admin_ensure_internal_user") {
		payload.generate_password = false;
		payload.return_password = false;
	}
	if (Buffer.byteLength(JSON.stringify(payload)) > 2097152) invalid();
	return payload;
}
export function checkExtraResult(
	name: string,
	result: Record<string, unknown>,
	payload: Record<string, unknown>,
) {
	const expected = payload.kind === "user" ? payload.username : payload.slug;
	if (
		[
			"delete_file",
			"delete_space",
			"render_index",
			"manage_shared_group_grant",
		].includes(name) ||
		(name === "manage_shared_membership" && "emails" in payload)
	)
		if (result.kind !== payload.kind || result.slug !== expected) invalid();
	const prefix = `/spaces/${payload.kind === "user" ? "users" : payload.kind}/${expected}/`;
	if (
		[
			"delete_file",
			"delete_space",
			"render_index",
			"manage_shared_group_grant",
		].includes(name)
	) {
		if (
			result.path_prefix !== prefix ||
			result.url_prefix !== `https://static-spaces.sh3.agoralab.co${prefix}`
		)
			invalid();
	}
	if (
		name === "delete_file" &&
		result.path !== prefix + String(payload.relative_path)
	)
		invalid();
	if (
		name === "render_index" &&
		(result.path !== `${prefix}index.html` ||
			result.url !== `https://static-spaces.sh3.agoralab.co${prefix}index.html`)
	)
		invalid();
	if (name === "delete_space") {
		if (
			(result.acl as Record<string, unknown>).prefix !== prefix ||
			(result.directory as Record<string, unknown>).path_prefix !== prefix
		)
			invalid();
		if (payload.kind === "shared") {
			const slug = String(payload.slug);
			let normalized =
				slug.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") ||
				"space";
			if (normalized !== slug)
				normalized += `-${createHash("sha256").update(slug).digest("hex").slice(0, 8)}`;
			if (
				(result.application as Record<string, unknown>)?.slug !==
				`static-spaces-shared-${normalized}`
			)
				invalid();
		} else if (result.application !== null) invalid();
		const roles =
			payload.kind === "user"
				? ["viewers"]
				: payload.kind === "shared"
					? ["owners", "managers", "viewers"]
					: ["owners", "managers"];
		const groups = result.groups as Record<string, unknown>[];
		const names = roles.map(
			(role) =>
				`static-spaces-${payload.kind === "user" ? "users" : payload.kind}-${expected}-${role}`,
		);
		if (
			groups.length !== names.length ||
			new Set(groups.map((g) => g.name)).size !== names.length ||
			groups.some((g) => !names.includes(String(g.name)))
		)
			invalid();
	}
	if (name === "manage_shared_group_grant") {
		const rule = result.acl as Record<string, unknown>;
		const groups =
			typeof rule.groups === "string"
				? rule.groups
						.split(",")
						.map((g) => g.trim())
						.filter(Boolean)
				: (rule.groups as string[]);
		const viewer = `static-spaces-shared-${payload.slug}-viewers`;
		if (
			rule.prefix !== prefix ||
			!(rule.enabled === true || rule.enabled === 1) ||
			groups[0] !== viewer ||
			groups.includes(String(payload.group)) !== (payload.action === "add") ||
			JSON.stringify(groups) !== JSON.stringify(result.acl_groups)
		)
			invalid();
		const binding = result.application_binding as Record<string, unknown>;
		if (
			payload.action === "add"
				? binding.enabled !== true || binding.negate !== false
				: binding.deleted === undefined || binding.group !== payload.group
		)
			invalid();
	}
	if (name === "manage_shared_membership") {
		const expectedGroup = `static-spaces-shared-${payload.slug}-${payload.role}s`;
		const receipts = Array.isArray(result.memberships)
			? result.memberships
			: [result];
		if (
			receipts.length !==
				(Array.isArray(payload.emails) ? payload.emails.length : 1) ||
			receipts.some(
				(m) =>
					m.group !== expectedGroup || m.member !== (payload.action === "add"),
			)
		)
			invalid();
		if ("username" in payload && result.username !== payload.username)
			invalid();
		if (
			"emails" in payload &&
			JSON.stringify(result.emails) !== JSON.stringify(payload.emails)
		)
			invalid();
	}
	if (
		name === "admin_manage_membership" &&
		(result.username !== payload.username ||
			result.group !== payload.group ||
			result.member !== (payload.action === "add"))
	)
		invalid();
	if (
		name === "admin_check_access" &&
		(result.username !== payload.username || result.path !== payload.path)
	)
		invalid();
	if (name === "admin_set_acl") {
		const groups =
			typeof result.groups === "string"
				? result.groups
						.split(",")
						.map((g) => g.trim())
						.filter(Boolean)
				: result.groups;
		if (
			result.prefix !== payload.prefix ||
			Boolean(result.enabled) !== payload.enabled ||
			JSON.stringify(groups) !== JSON.stringify(payload.groups)
		)
			invalid();
	}
	if (
		name === "admin_ensure_group" &&
		(result.group as Record<string, unknown>).name !== payload.name
	)
		invalid();
	if (
		name === "edit_markdown_comment" &&
		((result.comment as Record<string, unknown>).id !== payload.comment_id ||
			(result.comment as Record<string, unknown>).body !== payload.body)
	)
		invalid();
	if (
		name === "delete_markdown_comment" &&
		result.comment_id !== payload.comment_id
	)
		invalid();
	if (name === "create_markdown_comment") {
		const thread = result.thread as {
			id: string;
			anchor: Record<string, unknown>;
			comments: Record<string, unknown>[];
		};
		if (
			("thread_id" in payload && thread.id !== payload.thread_id) ||
			!thread.comments.some((c) => c.body === payload.body)
		)
			invalid();
		if (
			"document_sha256" in payload &&
			thread.anchor.document_sha256 !== payload.document_sha256
		)
			invalid();
	}
	if (
		name === "admin_ensure_internal_user" &&
		(result.user as Record<string, unknown>).username !== payload.username
	)
		invalid();
	if (
		name === "manage_shared_group_grant" &&
		((result.group as Record<string, unknown>).name !== payload.group ||
			result.action !== payload.action)
	)
		invalid();
}
