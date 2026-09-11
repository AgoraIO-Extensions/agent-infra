import type {
	CredentialForExecution,
	ProviderCredentialConnector,
	ProviderExecutor,
} from "@agent-infra/connection-core";
import { confluenceServerExecutorDigest } from "./confluence-server-integrity.ts";
import type { JiraServerTokenProvider } from "./jira-server.ts";

const sourceCommit = "0cb0e0dd2ed686fa7fa2ff8d9eef97a7d6b31674";
const providerId = "confluence";
const apiOrigin = "https://confluence.agoralab.co";
const apiBasePath = "/rest/api";
const providerReleaseId = `confluence-server-7.11.0-${sourceCommit}-connection-v1`;
const credentialScope = "confluence.server.access";
const maxResponseBytes = 10 * 1024 * 1024;
const requestTimeoutMs = 12_000;
const cursorPattern = "^\\d+$";

type JsonObject = Record<string, unknown>;
type ActionEffect = "READ" | "WRITE";
type ConfluenceCredential = { password: string; username: string };
type RequestOptions = {
	body?: JsonObject;
	credentialProbe?: boolean;
	method?: "DELETE" | "GET" | "POST" | "PUT";
	query?: JsonObject;
};
type ActionSpec = {
	description: string;
	effect: ActionEffect;
	name: string;
	properties?: JsonObject;
	required?: readonly string[];
};

const stringField = { minLength: 1, type: "string" } as const;
const cursorField = { pattern: cursorPattern, type: "string" } as const;
const positiveInteger = { minimum: 1, type: "integer" } as const;
const bodyField = { minLength: 1, type: "string" } as const;
const pageProperties = { pageId: stringField };

const actionSpecs: readonly ActionSpec[] = [
	{
		description: "获取当前通过公司 Confluence Server 鉴权的用户。",
		effect: "READ",
		name: "get_current_user",
	},
	{
		description: "使用 CQL 搜索公司 Confluence Server 内容。",
		effect: "READ",
		name: "search_content",
		properties: {
			cql: stringField,
			cursor: cursorField,
			limit: { maximum: 100, minimum: 1, type: "integer" },
		},
		required: ["cql"],
	},
	{
		description: "列出当前用户可访问的 Confluence 空间。",
		effect: "READ",
		name: "list_spaces",
		properties: {
			cursor: cursorField,
			limit: { maximum: 100, minimum: 1, type: "integer" },
		},
	},
	{
		description: "按空间 Key 获取 Confluence 空间。",
		effect: "READ",
		name: "get_space",
		properties: { spaceKey: stringField },
		required: ["spaceKey"],
	},
	{
		description: "按页面 ID 获取 Confluence 页面及正文。",
		effect: "READ",
		name: "get_page",
		properties: { ...pageProperties, bodyFormat: stringField },
		required: ["pageId"],
	},
	{
		description: "按空间 Key 和标题获取 Confluence 页面。",
		effect: "READ",
		name: "get_page_by_title",
		properties: { spaceKey: stringField, title: stringField },
		required: ["spaceKey", "title"],
	},
	{
		description: "列出 Confluence 页面的直接子页面。",
		effect: "READ",
		name: "list_page_children",
		properties: {
			...pageProperties,
			cursor: cursorField,
			limit: { maximum: 100, minimum: 1, type: "integer" },
		},
		required: ["pageId"],
	},
	{
		description: "按空间首页递归列出有界的 Confluence 页面树。",
		effect: "READ",
		name: "list_page_tree",
		properties: {
			maxDepth: { maximum: 5, minimum: 0, type: "integer" },
			spaceKey: stringField,
		},
		required: ["spaceKey"],
	},
	{
		description: "获取 Confluence 页面指定历史版本。",
		effect: "READ",
		name: "get_page_history",
		properties: { ...pageProperties, version: positiveInteger },
		required: ["pageId", "version"],
	},
	{
		description: "获取 Confluence 页面两个版本的正文，供客户端比较差异。",
		effect: "READ",
		name: "get_page_diff",
		properties: {
			...pageProperties,
			fromVersion: positiveInteger,
			toVersion: positiveInteger,
		},
		required: ["pageId", "fromVersion", "toVersion"],
	},
	{
		description: "创建 Confluence 页面。",
		effect: "WRITE",
		name: "create_page",
		properties: {
			body: bodyField,
			bodyRepresentation: stringField,
			parentId: stringField,
			spaceKey: stringField,
			status: stringField,
			title: stringField,
		},
		required: ["spaceKey", "title", "body"],
	},
	{
		description: "更新 Confluence 页面，并自动计算或校验下一版本号。",
		effect: "WRITE",
		name: "update_page",
		properties: {
			...pageProperties,
			body: bodyField,
			bodyRepresentation: stringField,
			minorEdit: { type: "boolean" },
			parentId: stringField,
			spaceKey: stringField,
			status: stringField,
			title: stringField,
			versionComment: stringField,
			versionNumber: positiveInteger,
		},
		required: ["pageId", "title"],
	},
	{
		description: "移动 Confluence 页面到指定父页面或空间。",
		effect: "WRITE",
		name: "move_page",
		properties: {
			...pageProperties,
			parentId: stringField,
			position: { enum: ["append"], type: "string" },
			spaceKey: stringField,
		},
		required: ["pageId"],
	},
	{
		description: "删除 Confluence 页面。该操作具有破坏性。",
		effect: "WRITE",
		name: "delete_page",
		properties: pageProperties,
		required: ["pageId"],
	},
	{
		description: "列出 Confluence 页面评论。",
		effect: "READ",
		name: "list_comments",
		properties: {
			...pageProperties,
			cursor: cursorField,
			limit: { maximum: 100, minimum: 1, type: "integer" },
		},
		required: ["pageId"],
	},
	{
		description: "给 Confluence 页面添加评论。",
		effect: "WRITE",
		name: "add_comment",
		properties: { bodyText: bodyField, ...pageProperties },
		required: ["pageId", "bodyText"],
	},
	{
		description: "回复 Confluence 评论。",
		effect: "WRITE",
		name: "reply_comment",
		properties: { bodyText: bodyField, commentId: stringField },
		required: ["commentId", "bodyText"],
	},
	{
		description: "列出 Confluence 页面附件元数据。",
		effect: "READ",
		name: "list_attachments",
		properties: {
			...pageProperties,
			cursor: cursorField,
			filename: stringField,
			limit: { maximum: 100, minimum: 1, type: "integer" },
			mediaType: stringField,
		},
		required: ["pageId"],
	},
] as const;

export const confluenceServerConnectionCatalog = {
	actions: actionSpecs.map((action) => ({
		description: action.description,
		effect: action.effect,
		id: `${providerId}.${action.name}@v1`,
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
		credential: "confluence-server-basic-with-server-access-token",
		headers: ["Authorization", "accessToken"],
		scheme: "Basic + custom accessToken",
	},
	deploymentProfile: {
		apiOrigin,
		build: "711000",
		deployment: "server",
		identity: "GET /rest/api/user/current active user",
		product: "Confluence",
		version: "7.11.0",
	},
	executorDigest: confluenceServerExecutorDigest,
	provider: providerId,
	providerReleaseId,
	sourceCommit,
} as const;

export class ConfluenceServerAdapter
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
		const user = await this.requestJson(credential, "/user/current", {
			credentialProbe: true,
		});
		const identifiers = [
			readString(user, "username"),
			readString(user, "name"),
			readString(user, "key"),
			readString(user, "emailAddress"),
		].filter((value): value is string => Boolean(value));
		if (
			user.active === false ||
			!identifiers.some((value) => value === credential.username)
		) {
			throw invalidCredential(
				"Confluence user identity is missing or inactive",
			);
		}
		const externalAccount = identifiers[0];
		if (!externalAccount) {
			throw invalidCredential(
				"Confluence user identity is missing an account identifier",
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
				return this.requestJson(credential, "/user/current");
			case "search_content":
				return this.searchContent(credential, value);
			case "list_spaces":
				return this.listSpaces(credential, value);
			case "get_space":
				return {
					space: await this.requestJson(
						credential,
						`/space/${segment(value, "spaceKey")}`,
					),
				};
			case "get_page":
				return {
					page: await this.getPage(
						credential,
						stringValue(value, "pageId"),
						value,
					),
				};
			case "get_page_by_title":
				return this.getPageByTitle(credential, value);
			case "list_page_children":
				return this.listPageChildren(credential, value);
			case "list_page_tree":
				return this.listPageTree(credential, value);
			case "get_page_history":
				return {
					page: await this.getPage(credential, stringValue(value, "pageId"), {
						version: numberValue(value, "version"),
					}),
				};
			case "get_page_diff":
				return this.getPageDiff(credential, value);
			case "create_page":
				return this.createPage(credential, value);
			case "update_page":
				return this.updatePage(credential, value);
			case "move_page":
				return this.movePage(credential, value);
			case "delete_page":
				await this.request(credential, `/content/${segment(value, "pageId")}`, {
					method: "DELETE",
				});
				return { pageId: stringValue(value, "pageId"), deleted: true };
			case "list_comments":
				return this.listComments(credential, value);
			case "add_comment":
				return {
					comment: await this.requestJson(credential, "/content", {
						body: {
							body: {
								storage: {
									representation: "storage",
									value: stringValue(value, "bodyText"),
								},
							},
							container: {
								id: stringValue(value, "pageId"),
								status: "current",
								type: "page",
							},
							type: "comment",
						},
						method: "POST",
					}),
				};
			case "reply_comment":
				return {
					comment: await this.requestJson(credential, "/content", {
						body: {
							body: {
								storage: {
									representation: "storage",
									value: stringValue(value, "bodyText"),
								},
							},
							container: {
								id: stringValue(value, "commentId"),
								status: "current",
								type: "comment",
							},
							type: "comment",
						},
						method: "POST",
					}),
				};
			case "list_attachments":
				return this.listAttachments(credential, value);
			default:
				throw providerError(`Unsupported Confluence Server action: ${action}`);
		}
	}

	private async searchContent(
		credential: ConfluenceCredential,
		value: JsonObject,
	) {
		const payload = await this.requestJson(credential, "/content/search", {
			query: {
				cql: stringValue(value, "cql"),
				limit: numberValue(value, "limit") ?? 25,
				start: cursorStart(value),
			},
		});
		return {
			results: jsonArray(payload, "results"),
			pagination: pagination(payload),
		};
	}

	private async listSpaces(
		credential: ConfluenceCredential,
		value: JsonObject,
	) {
		const payload = await this.requestJson(credential, "/space", {
			query: {
				limit: numberValue(value, "limit") ?? 25,
				start: cursorStart(value),
			},
		});
		return {
			spaces: jsonArray(payload, "results"),
			pagination: pagination(payload),
		};
	}

	private async getPage(
		credential: ConfluenceCredential,
		pageId: string,
		value: JsonObject,
	) {
		return this.requestJson(
			credential,
			`/content/${encodeURIComponent(pageId)}`,
			{
				query: {
					expand:
						typeof value.bodyFormat === "string"
							? `space,version,body.${value.bodyFormat}`
							: "space,version,body.storage",
					version: numberValue(value, "version"),
				},
			},
		);
	}

	private async getPageByTitle(
		credential: ConfluenceCredential,
		value: JsonObject,
	) {
		const payload = await this.requestJson(credential, "/content", {
			query: {
				expand: "space,version,body.storage",
				limit: 2,
				spaceKey: stringValue(value, "spaceKey"),
				title: stringValue(value, "title"),
				type: "page",
			},
		});
		const pages = jsonArray(payload, "results");
		if (pages.length > 1)
			throw providerError("Confluence page title is ambiguous");
		return { page: pages[0] ?? null };
	}

	private async listPageChildren(
		credential: ConfluenceCredential,
		value: JsonObject,
	) {
		const payload = await this.requestJson(
			credential,
			`/content/${segment(value, "pageId")}/child/page`,
			{ query: paginationQuery(value) },
		);
		return {
			pages: jsonArray(payload, "results"),
			pagination: pagination(payload),
		};
	}

	private async listPageTree(
		credential: ConfluenceCredential,
		value: JsonObject,
	) {
		const spaceKey = stringValue(value, "spaceKey");
		const maxDepth = numberValue(value, "maxDepth") ?? 3;
		const space = await this.requestJson(
			credential,
			`/space/${segment(value, "spaceKey")}`,
			{ query: { expand: "homepage" } },
		);
		const homepageId = readString(objectValue(space, "homepage"), "id");
		if (!homepageId) return { pages: [] };
		const root = await this.getPage(credential, homepageId, {});
		const pages: JsonObject[] = [];
		const queue: Array<{ depth: number; page: JsonObject }> = [
			{ depth: 0, page: root },
		];
		while (queue.length && pages.length < 100) {
			const item = queue.shift();
			if (!item) break;
			pages.push({ ...item.page, depth: item.depth });
			if (item.depth >= maxDepth) continue;
			const children = await this.requestJson(
				credential,
				`/content/${segment(item.page, "id")}/child/page`,
				{ query: { expand: "space,version", limit: 100, start: 0 } },
			);
			for (const child of jsonArray(children, "results")) {
				queue.push({ depth: item.depth + 1, page: child });
			}
		}
		return { spaceKey, pages };
	}

	private async getPageDiff(
		credential: ConfluenceCredential,
		value: JsonObject,
	) {
		const pageId = stringValue(value, "pageId");
		const fromVersion = numberValue(value, "fromVersion");
		const toVersion = numberValue(value, "toVersion");
		if (!fromVersion || !toVersion)
			throw providerError("Confluence page versions are invalid");
		const [from, to] = await Promise.all([
			this.getPage(credential, pageId, { version: fromVersion }),
			this.getPage(credential, pageId, { version: toVersion }),
		]);
		return { from, fromVersion, pageId, to, toVersion };
	}

	private async createPage(
		credential: ConfluenceCredential,
		value: JsonObject,
	) {
		const body: JsonObject = {
			body: {
				storage: {
					representation:
						typeof value.bodyRepresentation === "string"
							? value.bodyRepresentation
							: "storage",
					value: stringValue(value, "body"),
				},
			},
			space: { key: stringValue(value, "spaceKey") },
			status: typeof value.status === "string" ? value.status : "current",
			title: stringValue(value, "title"),
			type: "page",
		};
		if (typeof value.parentId === "string")
			body.ancestors = [{ id: value.parentId }];
		return {
			page: await this.requestJson(credential, "/content", {
				body,
				method: "POST",
			}),
		};
	}

	private async updatePage(
		credential: ConfluenceCredential,
		value: JsonObject,
	) {
		const pageId = stringValue(value, "pageId");
		const current = await this.getPage(credential, pageId, {});
		const currentVersion = objectValue(current, "version");
		const nextVersion =
			numberValue(value, "versionNumber") ??
			(numberValue(currentVersion, "number") ?? 0) + 1;
		const body: JsonObject = {
			id: pageId,
			status:
				typeof value.status === "string"
					? value.status
					: (readString(current, "status") ?? "current"),
			title: stringValue(value, "title"),
			type: "page",
			version: {
				minorEdit: value.minorEdit === true,
				number: nextVersion,
				...(typeof value.versionComment === "string"
					? { message: value.versionComment }
					: {}),
			},
		};
		if (typeof value.body === "string") {
			body.body = {
				storage: {
					representation:
						typeof value.bodyRepresentation === "string"
							? value.bodyRepresentation
							: "storage",
					value: stringValue(value, "body"),
				},
			};
		}
		if (typeof value.parentId === "string")
			body.ancestors = [{ id: value.parentId }];
		if (typeof value.spaceKey === "string")
			body.space = { key: value.spaceKey };
		return {
			page: await this.requestJson(
				credential,
				`/content/${encodeURIComponent(pageId)}`,
				{ body, method: "PUT" },
			),
		};
	}

	private async movePage(credential: ConfluenceCredential, value: JsonObject) {
		const pageId = stringValue(value, "pageId");
		if (value.position !== undefined && value.position !== "append")
			throw providerError("Confluence move position must be append");
		const current = await this.getPage(credential, pageId, {});
		const version =
			(numberValue(objectValue(current, "version"), "number") ?? 0) + 1;
		const body: JsonObject = {
			id: pageId,
			status: readString(current, "status") ?? "current",
			title: readString(current, "title") ?? pageId,
			type: "page",
			version: { number: version },
		};
		const currentStorage = objectValue(objectValue(current, "body"), "storage");
		if (typeof currentStorage.value === "string") {
			body.body = {
				storage: { representation: "storage", value: currentStorage.value },
			};
		}
		if (typeof value.parentId === "string")
			body.ancestors = [{ id: value.parentId }];
		if (typeof value.spaceKey === "string")
			body.space = { key: value.spaceKey };
		return {
			page: await this.requestJson(
				credential,
				`/content/${encodeURIComponent(pageId)}`,
				{ body, method: "PUT" },
			),
		};
	}

	private async listComments(
		credential: ConfluenceCredential,
		value: JsonObject,
	) {
		const payload = await this.requestJson(
			credential,
			`/content/${segment(value, "pageId")}/child/comment`,
			{ query: paginationQuery(value) },
		);
		return {
			comments: jsonArray(payload, "results"),
			pagination: pagination(payload),
		};
	}

	private async listAttachments(
		credential: ConfluenceCredential,
		value: JsonObject,
	) {
		const payload = await this.requestJson(
			credential,
			`/content/${segment(value, "pageId")}/child/attachment`,
			{
				query: {
					...paginationQuery(value),
					filename: stringValue(value, "filename", false),
					mediaType: stringValue(value, "mediaType", false),
				},
			},
		);
		return {
			attachments: jsonArray(payload, "results"),
			pagination: pagination(payload),
		};
	}

	private requestJson(
		credential: ConfluenceCredential,
		path: string,
		options: RequestOptions = {},
	) {
		return this.tokenProvider
			.getAccessToken()
			.then((accessToken) =>
				requestJson(this.fetcher, credential, accessToken, path, options),
			);
	}

	private request(
		credential: ConfluenceCredential,
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

function parseCredential(value: string): ConfluenceCredential {
	if (!value || value.length > 8_192)
		throw invalidCredential("Confluence credential is invalid");
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		throw invalidCredential("Confluence credential envelope is invalid");
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
		throw invalidCredential("Confluence credential envelope is invalid");
	const record = parsed as JsonObject;
	const username = stringValue(record, "username");
	const password = stringValue(record, "password");
	if (username.length > 256 || password.length > 1_024)
		throw invalidCredential("Confluence credential envelope is too large");
	return { password, username };
}

function invalidCredential(message: string) {
	return Object.assign(new Error(message), { providerCredentialInvalid: true });
}

function providerError(message: string) {
	return new Error(message);
}

function stringValue(value: JsonObject, key: string): string;
function stringValue(value: JsonObject, key: string, required: true): string;
function stringValue(
	value: JsonObject,
	key: string,
	required: false,
): string | undefined;
function stringValue(value: JsonObject, key: string, required = true) {
	const result = value[key];
	if (typeof result === "string" && result.trim()) return result.trim();
	if (!required) return undefined;
	throw providerError(`Confluence field is required: ${key}`);
}

function numberValue(value: JsonObject, key: string) {
	const result = value[key];
	return typeof result === "number" && Number.isInteger(result)
		? result
		: undefined;
}

function readString(value: JsonObject, key: string) {
	const result = value[key];
	return typeof result === "string" && result ? result : undefined;
}

function objectValue(value: JsonObject, key: string) {
	const result = value[key];
	return typeof result === "object" && result !== null && !Array.isArray(result)
		? (result as JsonObject)
		: {};
}

function jsonArray(value: JsonObject, key: string) {
	const result = value[key];
	return Array.isArray(result)
		? result.filter(
				(item): item is JsonObject =>
					typeof item === "object" && item !== null && !Array.isArray(item),
			)
		: [];
}

function segment(value: JsonObject, key: string) {
	return encodeURIComponent(stringValue(value, key));
}

function cursorStart(value: JsonObject) {
	return (
		numberValue(value, "startAt") ??
		Number(stringValue(value, "cursor", false) ?? 0)
	);
}

function paginationQuery(value: JsonObject) {
	return {
		limit: numberValue(value, "limit") ?? 25,
		start: cursorStart(value),
	};
}

function pagination(value: JsonObject) {
	const start = numberValue(value, "start") ?? 0;
	const limit = numberValue(value, "limit") ?? 25;
	const size = numberValue(value, "size") ?? jsonArray(value, "results").length;
	return { nextCursor: size >= limit ? String(start + limit) : null };
}

async function requestJson(
	fetcher: typeof fetch,
	credential: ConfluenceCredential,
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
		throw providerError("Confluence Server returned invalid JSON");
	return value;
}

async function requestValue(
	fetcher: typeof fetch,
	credential: ConfluenceCredential,
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
		throw providerError("Confluence Server returned invalid JSON");
	}
}

async function request(
	fetcher: typeof fetch,
	credential: ConfluenceCredential,
	accessToken: string,
	path: string,
	options: RequestOptions,
) {
	if (!path.startsWith("/") || path.startsWith("//"))
		throw providerError("Confluence request path is invalid");
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
			throw invalidCredential("Confluence credential was rejected");
		if (!response.ok)
			throw providerError(
				`Confluence Server request failed (${response.status})`,
			);
		return response;
	} catch (error) {
		if (
			typeof error === "object" &&
			error !== null &&
			(error as { providerCredentialInvalid?: unknown })
				.providerCredentialInvalid === true
		)
			throw error;
		if (error instanceof Error && error.message.startsWith("Confluence"))
			throw error;
		throw providerError("Confluence Server request failed");
	} finally {
		clearTimeout(timeout);
	}
}

async function boundedText(response: Response) {
	const text = await response.text();
	if (Buffer.byteLength(text, "utf8") > maxResponseBytes)
		throw providerError("Confluence Server response is too large");
	return text;
}

function isJsonObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
