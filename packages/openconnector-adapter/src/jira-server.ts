import type {
	CredentialForExecution,
	ProviderCredentialConnector,
	ProviderExecutor,
} from "@agent-infra/connection-core";

import { jiraServerExecutorDigest } from "./jira-server-integrity.ts";

const sourceCommit = "5cd85feb1a19cb43a711fe305ea1b40f388792aa";
const providerId = "jira";
const apiOrigin = "https://jira.agoralab.co";
const apiBasePath = "/rest/api/2";
const providerReleaseId = `jira-server-7.11.0-${sourceCommit}-connection-v4`;
const credentialScope = "jira.server.access";
const maxResponseBytes = 10 * 1024 * 1024;
const requestTimeoutMs = 12_000;

type JsonObject = Record<string, unknown>;
type ActionEffect = "READ" | "WRITE";

type ActionSpec = {
	description: string;
	effect: ActionEffect;
	name: string;
	properties?: JsonObject;
	required?: readonly string[];
};

type JiraCredential = {
	password: string;
	username: string;
};

export type JiraServerTokenConfig = {
	clientId: string;
	clientSecret: string;
	password: string;
	tokenUrl: string;
	username: string;
};

export type JiraServerTokenProvider = {
	getAccessToken(): Promise<string>;
};

const stringField = { minLength: 1, type: "string" } as const;
const cursorField = { pattern: "^\\d+$", type: "string" } as const;
const nonNegativeInteger = { minimum: 0, type: "integer" } as const;
const objectField = { additionalProperties: true, type: "object" } as const;
const expandField = { items: stringField, minItems: 1, type: "array" } as const;
const issueProperties = { issueIdOrKey: stringField };
const commentProperties = {
	...issueProperties,
	commentId: stringField,
};
const paginationProperties = {
	limit: { maximum: 100, minimum: 1, type: "integer" },
	startAt: nonNegativeInteger,
};
const openConnectorPaginationProperties = {
	cursor: cursorField,
	limit: { maximum: 100, minimum: 1, type: "integer" },
};

const actionSpecs: readonly ActionSpec[] = [
	{
		description: "获取当前通过公司 Jira Server 鉴权的用户。",
		effect: "READ",
		name: "get_current_user",
	},
	{
		description: "列出当前用户可访问的 Jira 项目。",
		effect: "READ",
		name: "list_projects",
		properties: { ...openConnectorPaginationProperties, expand: expandField },
	},
	{
		description: "按项目 ID 或 key 获取 Jira 项目。",
		effect: "READ",
		name: "get_project",
		properties: { expand: expandField, projectIdOrKey: stringField },
		required: ["projectIdOrKey"],
	},
	{
		description: "使用 JQL 搜索 Jira Issue。",
		effect: "READ",
		name: "search_issues",
		properties: {
			...openConnectorPaginationProperties,
			expand: expandField,
			fields: { items: stringField, type: "array" },
			jql: stringField,
		},
		required: ["jql"],
	},
	{
		description: "按 Issue ID 或 key 获取 Jira Issue。",
		effect: "READ",
		name: "get_issue",
		properties: {
			expand: expandField,
			fields: { items: stringField, type: "array" },
			...issueProperties,
		},
		required: ["issueIdOrKey"],
	},
	{
		description: "创建 Jira Issue。",
		effect: "WRITE",
		name: "create_issue",
		properties: {
			descriptionText: stringField,
			description: stringField,
			extraFields: objectField,
			issueTypeId: stringField,
			issueTypeName: stringField,
			projectId: stringField,
			projectKey: stringField,
			summary: stringField,
		},
		required: ["projectKey", "issueTypeName", "summary"],
	},
	{
		description: "列出一个 Jira Issue 的评论。",
		effect: "READ",
		name: "list_issue_comments",
		properties: { ...issueProperties, ...openConnectorPaginationProperties },
		required: ["issueIdOrKey"],
	},
	{
		description: "给 Jira Issue 添加评论。",
		effect: "WRITE",
		name: "add_comment",
		properties: { bodyText: stringField, ...issueProperties },
		required: ["issueIdOrKey", "bodyText"],
	},
	{
		description: "更新 Jira Issue 字段。",
		effect: "WRITE",
		name: "update_issue",
		properties: { fields: objectField, ...issueProperties },
		required: ["issueIdOrKey", "fields"],
	},
	{
		description: "删除 Jira Issue。该操作具有破坏性。",
		effect: "WRITE",
		name: "delete_issue",
		properties: issueProperties,
		required: ["issueIdOrKey"],
	},
	{
		description: "列出 Jira Issue 可用的状态流转。",
		effect: "READ",
		name: "list_issue_transitions",
		properties: issueProperties,
		required: ["issueIdOrKey"],
	},
	{
		description: "将 Jira Issue 流转到指定 transition ID。",
		effect: "WRITE",
		name: "transition_issue",
		properties: { issueIdOrKey: stringField, transitionId: stringField },
		required: ["issueIdOrKey", "transitionId"],
	},
	{
		description: "获取 Jira Issue 的 changelog。",
		effect: "READ",
		name: "get_issue_changelog",
		properties: { ...issueProperties, ...paginationProperties },
		required: ["issueIdOrKey"],
	},
	{
		description: "列出 Jira Issue 附件元数据。",
		effect: "READ",
		name: "list_issue_attachments",
		properties: issueProperties,
		required: ["issueIdOrKey"],
	},
	{
		description: "搜索 Jira 字段定义。",
		effect: "READ",
		name: "search_fields",
		properties: { query: { type: "string" } },
	},
	{
		description: "获取项目和 Issue 类型可用的创建字段选项。",
		effect: "READ",
		name: "get_field_options",
		properties: { issueType: stringField, projectKey: stringField },
		required: ["projectKey", "issueType"],
	},
	{
		description: "按用户名获取 Jira 用户。",
		effect: "READ",
		name: "get_user",
		properties: { username: stringField },
		required: ["username"],
	},
	{
		description: "按用户名前缀搜索 Jira 用户。",
		effect: "READ",
		name: "search_users",
		properties: {
			username: stringField,
			...paginationProperties,
		},
		required: ["username"],
	},
	{
		description: "编辑 Jira Issue 评论。",
		effect: "WRITE",
		name: "edit_comment",
		properties: { bodyText: stringField, ...commentProperties },
		required: ["issueIdOrKey", "commentId", "bodyText"],
	},
	{
		description: "批量创建 Jira Issue。该操作可能产生部分成功结果。",
		effect: "WRITE",
		name: "bulk_create_issues",
		properties: {
			issues: {
				items: objectField,
				maxItems: 50,
				type: "array",
			},
		},
		required: ["issues"],
	},
] as const;

const tokenRefreshSkewMs = 60_000;
const defaultTokenTtlSeconds = 300;

export class JiraServerOAuthTokenProvider implements JiraServerTokenProvider {
	private cached: { expiresAt: number; value: string } | undefined;
	private pending: Promise<string> | undefined;
	private readonly fetcher: typeof fetch;
	private readonly config: JiraServerTokenConfig;
	private readonly now: () => number;

	constructor(
		fetcher: typeof fetch,
		config: JiraServerTokenConfig,
		now: () => number = Date.now,
	) {
		this.fetcher = fetcher;
		this.config = config;
		this.now = now;
	}

	getAccessToken() {
		if (
			this.cached &&
			this.cached.expiresAt - this.now() > tokenRefreshSkewMs
		) {
			return Promise.resolve(this.cached.value);
		}
		if (!this.pending) {
			this.pending = this.issueToken().finally(() => {
				this.pending = undefined;
			});
		}
		return this.pending;
	}

	private async issueToken() {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
		try {
			const response = await this.fetcher(this.config.tokenUrl, {
				body: new URLSearchParams({
					client_id: this.config.clientId,
					client_secret: this.config.clientSecret,
					grant_type: "password",
					password: this.config.password,
					username: this.config.username,
				}).toString(),
				headers: {
					accept: "application/json",
					"content-type": "application/x-www-form-urlencoded",
				},
				method: "POST",
				redirect: "error",
				signal: controller.signal,
			});
			if (!response.ok) throw providerError("Jira access token service failed");
			let payload: unknown;
			try {
				payload = JSON.parse(await boundedText(response));
			} catch {
				throw providerError("Jira access token service returned invalid JSON");
			}
			if (!isJsonObject(payload) || typeof payload.access_token !== "string") {
				throw providerError(
					"Jira access token service returned no access token",
				);
			}
			const token = payload.access_token.trim();
			if (!token)
				throw providerError(
					"Jira access token service returned no access token",
				);
			const reportedTtl = Number(payload.expires_in);
			const ttlSeconds =
				Number.isFinite(reportedTtl) && reportedTtl > 0
					? Math.min(reportedTtl, 86_400)
					: defaultTokenTtlSeconds;
			this.cached = {
				expiresAt: this.now() + ttlSeconds * 1_000,
				value: token,
			};
			return token;
		} catch (error) {
			if (error instanceof Error && error.message.startsWith("Jira "))
				throw error;
			throw providerError("Jira access token service failed");
		} finally {
			clearTimeout(timeout);
		}
	}
}

export const jiraServerConnectionCatalog = {
	actions: actionSpecs.map((action) => ({
		description: action.description,
		effect: action.effect,
		id: `${providerId}.${action.name}@v4`,
		inputSchema: {
			additionalProperties: false,
			properties: action.properties ?? {},
			required: action.required ?? [],
			type: "object",
		},
		name: `${providerId}.${action.name}`,
		requiredScopes: [credentialScope],
	})),
	authProfile: {
		credential: "jira-server-basic-with-server-access-token",
		headers: ["Authorization", "accessToken"],
		scheme: "Basic + custom accessToken",
	},
	deploymentProfile: {
		apiOrigin,
		build: "711000",
		deployment: "server",
		identity: "GET /rest/api/2/myself active user",
		product: "Jira",
		version: "7.11.0",
	},
	executorDigest: jiraServerExecutorDigest,
	provider: providerId,
	providerReleaseId,
	sourceCommit,
} as const;

export class JiraServerAdapter
	implements ProviderCredentialConnector, ProviderExecutor
{
	readonly providerId = providerId;
	readonly providerReleaseId = providerReleaseId;
	private readonly fetcher: typeof fetch;
	private readonly tokenProvider: JiraServerTokenProvider;

	constructor(fetcher: typeof fetch, tokenProvider: JiraServerTokenProvider) {
		this.fetcher = fetcher;
		this.tokenProvider = tokenProvider;
	}

	async validateCredential(encodedCredential: string) {
		const credential = parseCredential(encodedCredential);
		const user = await this.requestJson(credential, "/myself", {
			credentialProbe: true,
		});
		const identifiers = [
			readString(user, "name"),
			readString(user, "key"),
			readString(user, "emailAddress"),
		].filter((value): value is string => Boolean(value));
		if (
			user.active !== true ||
			!identifiers.some((value) => value === credential.username)
		) {
			throw invalidCredential("Jira user identity is missing or inactive");
		}
		const externalAccount = identifiers[0];
		if (!externalAccount) {
			throw invalidCredential(
				"Jira user identity is missing an account identifier",
			);
		}
		return {
			accessToken: encodedCredential,
			displayName: readString(user, "displayName") ?? externalAccount,
			externalAccount,
			grantedScopes: [credentialScope],
			providerId,
			providerReleaseId,
		};
	}

	async execute(input: {
		action: string;
		credential: CredentialForExecution;
		input: JsonObject;
	}) {
		const action = input.action.replace(`${providerId}.`, "");
		const credential = parseCredential(input.credential.accessToken);
		const value = input.input;
		switch (action) {
			case "get_current_user":
				return this.requestJson(credential, "/myself");
			case "list_projects": {
				const projects = jsonArray(
					await this.requestValue(credential, "/project", {
						query: {
							expand: stringArray(value, "expand").join(",") || undefined,
						},
					}),
				);
				const startAt = cursorStart(value);
				const limit = numberValue(value, "limit") ?? 100;
				return {
					projects: projects.slice(startAt, startAt + limit),
					pagination: {
						nextCursor: nextCursorFrom(startAt, limit, projects.length),
					},
				};
			}
			case "get_project":
				return {
					project: await this.requestJson(
						credential,
						`/project/${segment(value, "projectIdOrKey")}`,
						{
							query: {
								expand: stringArray(value, "expand").join(",") || undefined,
							},
						},
					),
				};
			case "search_issues":
				return this.searchIssues(credential, value);
			case "get_issue":
				return {
					issue: await this.requestJson(
						credential,
						`/issue/${segment(value, "issueIdOrKey")}`,
						{ query: issueQuery(value) },
					),
				};
			case "create_issue":
				return this.createIssue(credential, value);
			case "list_issue_comments":
				return this.listIssueComments(credential, value);
			case "add_comment":
				return {
					comment: await this.requestJson(
						credential,
						`/issue/${segment(value, "issueIdOrKey")}/comment`,
						{ body: { body: stringValue(value, "bodyText") }, method: "POST" },
					),
				};
			case "update_issue":
				await this.request(
					credential,
					`/issue/${segment(value, "issueIdOrKey")}`,
					{ body: { fields: objectValue(value, "fields") }, method: "PUT" },
				);
				return {
					issueIdOrKey: stringValue(value, "issueIdOrKey"),
					updated: true,
				};
			case "delete_issue":
				await this.request(
					credential,
					`/issue/${segment(value, "issueIdOrKey")}`,
					{ method: "DELETE", query: { deleteSubtasks: "true" } },
				);
				return {
					issueIdOrKey: stringValue(value, "issueIdOrKey"),
					deleted: true,
				};
			case "list_issue_transitions":
				return this.requestJson(
					credential,
					`/issue/${segment(value, "issueIdOrKey")}/transitions`,
				);
			case "transition_issue":
				await this.request(
					credential,
					`/issue/${segment(value, "issueIdOrKey")}/transitions`,
					{
						body: { transition: { id: stringValue(value, "transitionId") } },
						method: "POST",
					},
				);
				return {
					issueIdOrKey: stringValue(value, "issueIdOrKey"),
					transitionId: stringValue(value, "transitionId"),
				};
			case "get_issue_changelog":
				return this.getIssueChangelog(credential, value);
			case "list_issue_attachments":
				return this.listIssueAttachments(credential, value);
			case "search_fields":
				return this.searchFields(credential, value);
			case "get_field_options":
				return this.getFieldOptions(credential, value);
			case "get_user":
				return {
					user: await this.requestJson(credential, "/user", {
						query: { username: stringValue(value, "username") },
					}),
				};
			case "search_users":
				return {
					users: await this.requestJson(credential, "/user/search", {
						query: {
							includeActive: true,
							includeInactive: false,
							maxResults: value.limit,
							startAt: value.startAt,
							username: stringValue(value, "username"),
						},
					}),
				};
			case "edit_comment":
				return {
					comment: await this.requestJson(
						credential,
						`/issue/${segment(value, "issueIdOrKey")}/comment/${segment(value, "commentId")}`,
						{ body: { body: stringValue(value, "bodyText") }, method: "PUT" },
					),
				};
			case "bulk_create_issues": {
				const payload = await this.requestJson(credential, "/issue/bulk", {
					body: { issueUpdates: arrayOfObjects(value, "issues") },
					method: "POST",
				});
				return {
					issues: arrayOfObjects(payload, "issues"),
					errors: arrayOfObjects(payload, "errors"),
				};
			}
			default:
				throw providerError(`Unsupported Jira Server action: ${action}`);
		}
	}

	private async searchIssues(credential: JiraCredential, value: JsonObject) {
		const expand = stringArray(value, "expand");
		const fields = stringArray(value, "fields");
		const payload = await this.requestJson(credential, "/search", {
			body: compact({
				expand: expand.length ? expand : undefined,
				fields: fields.length ? fields : undefined,
				jql: stringValue(value, "jql"),
				maxResults: numberValue(value, "limit"),
				startAt: cursorStart(value),
			}),
			method: "POST",
		});
		return {
			issues: arrayOfObjects(payload, "issues"),
			pagination: {
				nextCursor: nextCursor(payload),
			},
		};
	}

	private async createIssue(credential: JiraCredential, value: JsonObject) {
		const fields = {
			...objectValue(value, "extraFields"),
			issuetype: compact({ id: value.issueTypeId, name: value.issueTypeName }),
			project: compact({ id: value.projectId, key: value.projectKey }),
			summary: stringValue(value, "summary"),
			...(typeof value.descriptionText === "string"
				? { description: value.descriptionText }
				: typeof value.description === "string"
					? { description: value.description }
					: {}),
		};
		return {
			issue: await this.requestJson(credential, "/issue", {
				body: { fields },
				method: "POST",
			}),
		};
	}

	private async listIssueComments(
		credential: JiraCredential,
		value: JsonObject,
	) {
		const payload = await this.requestJson(
			credential,
			`/issue/${segment(value, "issueIdOrKey")}/comment`,
			{ query: pagination(value) },
		);
		return {
			comments: arrayOfObjects(payload, "comments"),
			pagination: { nextCursor: nextCursor(payload) },
		};
	}

	private async getIssueChangelog(
		credential: JiraCredential,
		value: JsonObject,
	) {
		const payload = await this.requestJson(
			credential,
			`/issue/${segment(value, "issueIdOrKey")}`,
			{ query: { expand: "changelog", ...pagination(value) } },
		);
		return { changelog: objectValue(payload, "changelog") };
	}

	private async listIssueAttachments(
		credential: JiraCredential,
		value: JsonObject,
	) {
		const payload = await this.requestJson(
			credential,
			`/issue/${segment(value, "issueIdOrKey")}`,
			{ query: { fields: "attachment" } },
		);
		return {
			attachments: arrayOfObjects(objectValue(payload, "fields"), "attachment"),
		};
	}

	private async searchFields(credential: JiraCredential, value: JsonObject) {
		const fields = jsonArray(await this.requestValue(credential, "/field"));
		const query =
			typeof value.query === "string" ? value.query.toLowerCase() : "";
		return {
			fields: fields.filter(
				(field) =>
					!query ||
					String(field.name ?? "")
						.toLowerCase()
						.includes(query),
			),
		};
	}

	private getFieldOptions(credential: JiraCredential, value: JsonObject) {
		return this.requestJson(credential, "/issue/createmeta", {
			query: {
				expand: "projects.issuetypes.fields",
				projectKeys: stringValue(value, "projectKey"),
			},
		});
	}

	private requestJson(
		credential: JiraCredential,
		path: string,
		options: RequestOptions = {},
	) {
		return this.tokenProvider
			.getAccessToken()
			.then((accessToken) =>
				requestJson(this.fetcher, credential, accessToken, path, options),
			);
	}

	private requestValue(
		credential: JiraCredential,
		path: string,
		options: RequestOptions = {},
	) {
		return this.tokenProvider
			.getAccessToken()
			.then((accessToken) =>
				requestValue(this.fetcher, credential, accessToken, path, options),
			);
	}

	private request(
		credential: JiraCredential,
		path: string,
		options: RequestOptions = {},
	) {
		return this.tokenProvider
			.getAccessToken()
			.then((accessToken) =>
				request(this.fetcher, credential, accessToken, path, options),
			);
	}
}

function parseCredential(value: string): JiraCredential {
	if (!value || value.length > 8_192)
		throw invalidCredential("Jira credential is invalid");
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		throw invalidCredential("Jira credential envelope is invalid");
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
		throw invalidCredential("Jira credential envelope is invalid");
	const record = parsed as JsonObject;
	const username = credentialString(record, "username");
	const password = credentialString(record, "password");
	if (username.length > 256 || password.length > 1_024)
		throw invalidCredential("Jira credential envelope is too large");
	return { password, username };
}

function credentialString(value: JsonObject, key: string) {
	const entry = value[key];
	if (typeof entry !== "string" || !entry)
		throw invalidCredential(`Jira credential field is missing: ${key}`);
	return entry;
}

function issueQuery(value: JsonObject) {
	return compact({
		expand: stringArray(value, "expand").join(",") || undefined,
		fields: stringArray(value, "fields").join(",") || undefined,
	});
}

function pagination(value: JsonObject) {
	return compact({
		maxResults: numberValue(value, "limit"),
		startAt: cursorStart(value),
	});
}

function cursorStart(value: JsonObject) {
	if (typeof value.cursor === "string") return Number(value.cursor);
	return numberValue(value, "startAt") ?? 0;
}

function numberValue(value: JsonObject, key: string) {
	const entry = value[key];
	return Number.isSafeInteger(entry) ? Number(entry) : undefined;
}

function nextCursor(value: JsonObject) {
	const startAt = typeof value.startAt === "number" ? value.startAt : 0;
	const maxResults =
		typeof value.maxResults === "number" ? value.maxResults : 0;
	const total = typeof value.total === "number" ? value.total : startAt;
	const next = startAt + maxResults;
	return maxResults > 0 && next < total ? String(next) : null;
}

function nextCursorFrom(startAt: number, limit: number, total: number) {
	const next = startAt + limit;
	return limit > 0 && next < total ? String(next) : null;
}

function segment(value: JsonObject, key: string) {
	return encodeURIComponent(stringValue(value, key));
}

function stringValue(value: JsonObject, key: string) {
	const entry = value[key];
	if (typeof entry !== "string" || !entry)
		throw new Error(`${key} is required`);
	return entry;
}

function readString(value: unknown, key: string) {
	if (!isJsonObject(value)) return undefined;
	const entry = value[key];
	return typeof entry === "string" ? entry : undefined;
}

function stringArray(value: JsonObject, key: string) {
	const entry = value[key];
	return Array.isArray(entry)
		? entry.filter(
				(item): item is string => typeof item === "string" && item.length > 0,
			)
		: [];
}

function arrayOfObjects(value: unknown, key: string): JsonObject[] {
	const entry = objectValue(value, key);
	return Array.isArray(entry) ? entry.filter(isJsonObject) : [];
}

function jsonArray(value: unknown): JsonObject[] {
	return Array.isArray(value) ? value.filter(isJsonObject) : [];
}

function objectValue(value: unknown, key: string): JsonObject {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		return {};
	const entry = (value as JsonObject)[key];
	return typeof entry === "object" && entry !== null && !Array.isArray(entry)
		? (entry as JsonObject)
		: {};
}

function isJsonObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compact(value: JsonObject) {
	return Object.fromEntries(
		Object.entries(value).filter(([, entry]) => entry !== undefined),
	);
}

function providerError(message: string) {
	return new Error(message);
}

function invalidCredential(message: string) {
	return Object.assign(new Error(message), { providerCredentialInvalid: true });
}

type RequestOptions = {
	body?: JsonObject;
	credentialProbe?: boolean;
	method?: "DELETE" | "GET" | "POST" | "PUT";
	query?: JsonObject;
};

async function requestJson(
	fetcher: typeof fetch,
	credential: JiraCredential,
	accessToken: string,
	path: string,
	options: RequestOptions = {},
): Promise<JsonObject> {
	const value = await requestValue(
		fetcher,
		credential,
		accessToken,
		path,
		options,
	);
	if (!isJsonObject(value))
		throw providerError("Jira Server returned an invalid JSON response");
	return value;
}

async function requestValue(
	fetcher: typeof fetch,
	credential: JiraCredential,
	accessToken: string,
	path: string,
	options: RequestOptions = {},
): Promise<unknown> {
	const response = await request(
		fetcher,
		credential,
		accessToken,
		path,
		options,
	);
	if (response.status === 204) return { ok: true };
	const text = await boundedText(response);
	try {
		return JSON.parse(text);
	} catch {
		throw providerError("Jira Server returned an invalid JSON response");
	}
}

async function request(
	fetcher: typeof fetch,
	credential: JiraCredential,
	accessToken: string,
	path: string,
	options: RequestOptions,
) {
	if (!path.startsWith("/") || path.startsWith("//"))
		throw providerError("Jira Server request path is invalid");
	const url = new URL(`${apiBasePath}${path}`, apiOrigin);
	for (const [key, value] of Object.entries(options.query ?? {})) {
		if (
			typeof value === "string" ||
			typeof value === "number" ||
			typeof value === "boolean"
		)
			url.searchParams.set(key, String(value));
	}
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
	try {
		const response = await fetcher(url, {
			body:
				options.body === undefined ? undefined : JSON.stringify(options.body),
			headers: {
				accept: "application/json",
				accessToken,
				authorization: `Basic ${Buffer.from(`${credential.username}:${credential.password}`).toString("base64")}`,
				...(options.body === undefined
					? {}
					: { "content-type": "application/json" }),
			},
			method: options.method ?? "GET",
			redirect: "error",
			signal: controller.signal,
		});
		if (
			options.credentialProbe &&
			(response.status === 401 || response.status === 403)
		)
			throw invalidCredential("Jira credential was rejected");
		if (!response.ok)
			throw providerError(`Jira Server request failed (${response.status})`);
		return response;
	} catch (error) {
		if (
			typeof error === "object" &&
			error !== null &&
			(error as { providerCredentialInvalid?: unknown })
				.providerCredentialInvalid === true
		)
			throw error;
		if (error instanceof Error && error.message.startsWith("Jira Server"))
			throw error;
		throw providerError("Jira Server request failed");
	} finally {
		clearTimeout(timeout);
	}
}

async function boundedText(response: Response) {
	const declaredLength = Number(response.headers.get("content-length") ?? 0);
	if (declaredLength > maxResponseBytes)
		throw providerError("Jira Server response is too large");
	if (!response.body) return "";
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	let timedOut = false;
	const timeout = setTimeout(() => {
		timedOut = true;
		void reader.cancel();
	}, requestTimeoutMs);
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > maxResponseBytes) {
				await reader.cancel();
				throw providerError("Jira Server response is too large");
			}
			chunks.push(value);
		}
		if (timedOut) throw providerError("Jira Server response timed out");
	} catch (error) {
		if (timedOut) throw providerError("Jira Server response timed out");
		if (error instanceof Error && error.message.startsWith("Jira Server"))
			throw error;
		throw providerError("Jira Server response timed out");
	} finally {
		clearTimeout(timeout);
	}
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return new TextDecoder().decode(bytes);
}
