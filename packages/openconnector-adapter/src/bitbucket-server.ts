import type {
	CredentialForExecution,
	ProviderCredentialConnector,
	ProviderExecutor,
} from "@agent-infra/connection-core";

import { bitbucketServerExecutorDigest } from "./bitbucket-server-integrity.ts";

const sourceCommit = "0618e8cdaeaaaa77e2eb23938ac639867d4f03d7";
const providerId = "bitbucket";
const apiOrigin = "https://bitbucket-api.agoralab.co";
const providerReleaseId = `bitbucket-server-6.7.2-openconnector-${sourceCommit}-connection-v3`;
const credentialScope = "bitbucket.server.pat";
const maxResponseBytes = 5 * 1024 * 1024;
const requestTimeoutMs = 8_000;

type JsonObject = Record<string, unknown>;
type ActionEffect = "READ" | "WRITE";

type ActionSpec = {
	description: string;
	effect: ActionEffect;
	name: string;
	properties?: JsonObject;
	required?: readonly string[];
};

const stringField = { minLength: 1, type: "string" } as const;
const positiveInteger = { minimum: 1, type: "integer" } as const;
const paginationProperties = {
	limit: { maximum: 100, minimum: 1, type: "integer" },
	start: { minimum: 0, type: "integer" },
};
const repositoryProperties = {
	project: stringField,
	repository: stringField,
};
const pullRequestProperties = {
	...repositoryProperties,
	pullRequestId: positiveInteger,
};
const commentProperties = {
	...pullRequestProperties,
	commentId: positiveInteger,
};

const actionSpecs: readonly ActionSpec[] = [
	{
		description: "获取当前通过 Bitbucket Server PAT 鉴权的用户。",
		effect: "READ",
		name: "get_current_user",
	},
	{
		description: "分页列出当前用户可访问的 Bitbucket 项目。",
		effect: "READ",
		name: "list_projects",
		properties: paginationProperties,
	},
	{
		description: "按 project key 获取 Bitbucket 项目。",
		effect: "READ",
		name: "get_project",
		properties: { project: stringField },
		required: ["project"],
	},
	{
		description: "分页列出 Bitbucket 项目中的仓库。",
		effect: "READ",
		name: "list_repositories",
		properties: { ...paginationProperties, project: stringField },
		required: ["project"],
	},
	{
		description: "按 project key 和 repository slug 获取仓库。",
		effect: "READ",
		name: "get_repository",
		properties: repositoryProperties,
		required: ["project", "repository"],
	},
	{
		description: "在指定 Bitbucket 项目中创建仓库。",
		effect: "WRITE",
		name: "create_repository",
		properties: {
			description: { type: "string" },
			forkable: { type: "boolean" },
			name: stringField,
			project: stringField,
			public: { type: "boolean" },
			scmId: { enum: ["git"], type: "string" },
		},
		required: ["project", "name"],
	},
	{
		description: "分页列出 Bitbucket 仓库分支。",
		effect: "READ",
		name: "list_branches",
		properties: { ...paginationProperties, ...repositoryProperties },
		required: ["project", "repository"],
	},
	{
		description: "分页列出 Bitbucket 仓库提交。",
		effect: "READ",
		name: "list_commits",
		properties: {
			...paginationProperties,
			...repositoryProperties,
			path: stringField,
			since: stringField,
			until: stringField,
		},
		required: ["project", "repository"],
	},
	{
		description: "获取 Bitbucket 仓库中的一个提交。",
		effect: "READ",
		name: "get_commit",
		properties: { ...repositoryProperties, commit: stringField },
		required: ["project", "repository", "commit"],
	},
	{
		description: "获取一个 Bitbucket commit 的构建状态。",
		effect: "READ",
		name: "get_commit_build_status",
		properties: {
			...paginationProperties,
			...repositoryProperties,
			commit: stringField,
		},
		required: ["project", "repository", "commit"],
	},
	{
		description: "分页列出 Bitbucket 仓库 Pull Request。",
		effect: "READ",
		name: "list_pull_requests",
		properties: {
			...paginationProperties,
			...repositoryProperties,
			state: {
				enum: ["ALL", "OPEN", "MERGED", "DECLINED", "SUPERSEDED"],
				type: "string",
			},
		},
		required: ["project", "repository"],
	},
	{
		description: "获取 Bitbucket Pull Request。",
		effect: "READ",
		name: "get_pull_request",
		properties: pullRequestProperties,
		required: ["project", "repository", "pullRequestId"],
	},
	{
		description: "获取 Bitbucket Pull Request diff。",
		effect: "READ",
		name: "get_pull_request_diff",
		properties: pullRequestProperties,
		required: ["project", "repository", "pullRequestId"],
	},
	{
		description: "获取 Bitbucket Pull Request 最新提交的构建状态。",
		effect: "READ",
		name: "get_pull_request_build_status",
		properties: { ...paginationProperties, ...pullRequestProperties },
		required: ["project", "repository", "pullRequestId"],
	},
	{
		description: "在 Bitbucket 仓库中创建 Pull Request。",
		effect: "WRITE",
		name: "create_pull_request",
		properties: {
			...repositoryProperties,
			description: { type: "string" },
			destinationBranch: stringField,
			reviewerUsernames: {
				items: stringField,
				maxItems: 100,
				type: "array",
				uniqueItems: true,
			},
			sourceBranch: stringField,
			title: stringField,
		},
		required: [
			"project",
			"repository",
			"title",
			"sourceBranch",
			"destinationBranch",
		],
	},
	{
		description: "合并 Bitbucket Pull Request。",
		effect: "WRITE",
		name: "merge_pull_request",
		properties: {
			...pullRequestProperties,
			message: { type: "string" },
			version: { minimum: 0, type: "integer" },
		},
		required: ["project", "repository", "pullRequestId", "version"],
	},
	{
		description: "拒绝 Bitbucket Pull Request。",
		effect: "WRITE",
		name: "decline_pull_request",
		properties: {
			...pullRequestProperties,
			version: { minimum: 0, type: "integer" },
		},
		required: ["project", "repository", "pullRequestId", "version"],
	},
	{
		description: "批准 Bitbucket Pull Request。",
		effect: "WRITE",
		name: "approve_pull_request",
		properties: pullRequestProperties,
		required: ["project", "repository", "pullRequestId"],
	},
	{
		description: "取消当前用户对 Bitbucket Pull Request 的批准。",
		effect: "WRITE",
		name: "unapprove_pull_request",
		properties: pullRequestProperties,
		required: ["project", "repository", "pullRequestId"],
	},
	{
		description: "分页列出 Bitbucket Pull Request 评论。",
		effect: "READ",
		name: "list_pull_request_comments",
		properties: { ...paginationProperties, ...pullRequestProperties },
		required: ["project", "repository", "pullRequestId"],
	},
	{
		description: "获取一条 Bitbucket Pull Request 评论。",
		effect: "READ",
		name: "get_pull_request_comment",
		properties: commentProperties,
		required: ["project", "repository", "pullRequestId", "commentId"],
	},
	{
		description: "创建 Bitbucket Pull Request 评论。",
		effect: "WRITE",
		name: "create_pull_request_comment",
		properties: { ...pullRequestProperties, content: stringField },
		required: ["project", "repository", "pullRequestId", "content"],
	},
	{
		description: "回复 Bitbucket Pull Request 评论。",
		effect: "WRITE",
		name: "reply_pull_request_comment",
		properties: { ...commentProperties, content: stringField },
		required: [
			"project",
			"repository",
			"pullRequestId",
			"commentId",
			"content",
		],
	},
	{
		description: "更新 Bitbucket Pull Request 评论。",
		effect: "WRITE",
		name: "update_pull_request_comment",
		properties: {
			...commentProperties,
			content: stringField,
			version: { minimum: 0, type: "integer" },
		},
		required: [
			"project",
			"repository",
			"pullRequestId",
			"commentId",
			"content",
			"version",
		],
	},
	{
		description: "删除 Bitbucket Pull Request 评论。",
		effect: "WRITE",
		name: "delete_pull_request_comment",
		properties: {
			...commentProperties,
			version: { minimum: 0, type: "integer" },
		},
		required: [
			"project",
			"repository",
			"pullRequestId",
			"commentId",
			"version",
		],
	},
] as const;

export const bitbucketServerConnectionCatalog = {
	actions: actionSpecs.map((action) => ({
		description: action.description,
		effect: action.effect,
		id: `${providerId}.${action.name}@v3`,
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
		credential: "personal-access-token",
		header: "Authorization",
		scheme: "Bearer",
	},
	deploymentProfile: {
		apiOrigin,
		build: "6007002",
		deployment: "server",
		identity: "whoami + exact active user id",
		product: "Bitbucket Server",
		version: "6.7.2",
	},
	executorDigest: bitbucketServerExecutorDigest,
	provider: providerId,
	providerReleaseId,
	sourceCommit,
} as const;

export class BitbucketServerAdapter
	implements ProviderCredentialConnector, ProviderExecutor
{
	readonly providerId = providerId;
	readonly providerReleaseId = providerReleaseId;
	private readonly fetcher: typeof fetch;

	constructor(fetcher: typeof fetch) {
		this.fetcher = fetcher;
	}

	async validateCredential(accessToken: string) {
		const username = (
			await this.requestText(accessToken, "/plugins/servlet/applinks/whoami", {
				credentialProbe: true,
			})
		).trim();
		if (!username || username.length > 512) {
			throw invalidCredential("Bitbucket PAT identity lookup failed");
		}
		const matches: JsonObject[] = [];
		let start = 0;
		let complete = false;
		for (let pageNumber = 0; pageNumber < 10; pageNumber += 1) {
			const users = await this.requestJson(accessToken, "/rest/api/1.0/users", {
				credentialProbe: true,
				query: { filter: username, limit: 100, start },
			});
			matches.push(
				...pageValues(users).filter((entry) => {
					const name = readString(entry, "name");
					const email = readString(entry, "emailAddress");
					return (
						(name === username || email === username) &&
						entry.active === true &&
						entry.id !== undefined &&
						entry.id !== null
					);
				}),
			);
			if (users.isLastPage === true) {
				complete = true;
				break;
			}
			const next = users.nextPageStart;
			if (!Number.isSafeInteger(next) || Number(next) <= start) {
				throw providerError("Bitbucket user pagination is invalid");
			}
			start = Number(next);
		}
		if (!complete) {
			throw providerError("Bitbucket user pagination exceeded the safe limit");
		}
		if (matches.length !== 1) {
			throw invalidCredential(
				"Bitbucket PAT identity is missing, disabled, or ambiguous",
			);
		}
		const user = matches[0] as JsonObject;
		return {
			accessToken,
			displayName:
				readString(user, "displayName") ??
				readString(user, "name") ??
				String(user.id),
			externalAccount: String(user.id),
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
		const value = input.input;
		const token = input.credential.accessToken;
		const repoPath = () => repositoryPath(value);
		const pullRequestPath = () =>
			`${repoPath()}/pull-requests/${integer(value, "pullRequestId")}`;
		const commentPath = () =>
			`${pullRequestPath()}/comments/${integer(value, "commentId")}`;
		switch (action) {
			case "get_current_user": {
				const { accessToken: _accessToken, ...identity } =
					await this.validateCredential(token);
				return identity;
			}
			case "list_projects":
				return this.requestJson(token, "/rest/api/1.0/projects", {
					query: pagination(value),
				});
			case "get_project":
				return this.requestJson(
					token,
					`/rest/api/1.0/projects/${segment(value, "project")}`,
				);
			case "list_repositories":
				return this.requestJson(token, `${projectPath(value)}/repos`, {
					query: pagination(value),
				});
			case "get_repository":
				return this.requestJson(token, repoPath());
			case "create_repository":
				return this.requestJson(token, `${projectPath(value)}/repos`, {
					body: compact({
						description: value.description,
						forkable: value.forkable,
						name: value.name,
						public: value.public,
						scmId: value.scmId ?? "git",
					}),
					method: "POST",
				});
			case "list_branches":
				return this.requestJson(token, `${repoPath()}/branches`, {
					query: pagination(value),
				});
			case "list_commits":
				return this.requestJson(token, `${repoPath()}/commits`, {
					query: {
						...pagination(value),
						path: value.path,
						since: value.since,
						until: value.until,
					},
				});
			case "get_commit":
				return this.requestJson(
					token,
					`${repoPath()}/commits/${segment(value, "commit")}`,
				);
			case "get_commit_build_status": {
				const commit = segment(value, "commit");
				await this.requestJson(token, `${repoPath()}/commits/${commit}`);
				return this.requestJson(
					token,
					`/rest/build-status/1.0/commits/${commit}`,
					{
						query: pagination(value),
					},
				);
			}
			case "list_pull_requests":
				return this.requestJson(token, `${repoPath()}/pull-requests`, {
					query: { ...pagination(value), state: value.state },
				});
			case "get_pull_request":
				return this.requestJson(token, pullRequestPath());
			case "get_pull_request_diff":
				return {
					diff: await this.requestText(token, `${pullRequestPath()}.diff`),
				};
			case "get_pull_request_build_status": {
				const pullRequest = await this.requestJson(token, pullRequestPath());
				const fromRef = objectValue(pullRequest, "fromRef");
				const commit = readString(fromRef, "latestCommit");
				if (!commit) throw providerError("Pull Request has no source commit");
				return this.requestJson(
					token,
					`/rest/build-status/1.0/commits/${encodeURIComponent(commit)}`,
					{ query: pagination(value) },
				);
			}
			case "create_pull_request":
				return this.requestJson(token, `${repoPath()}/pull-requests`, {
					body: {
						description: value.description ?? "",
						fromRef: branchReference(value, "sourceBranch"),
						reviewers: stringArray(value.reviewerUsernames).map((name) => ({
							user: { name },
						})),
						title: value.title,
						toRef: branchReference(value, "destinationBranch"),
					},
					method: "POST",
				});
			case "merge_pull_request":
				return this.requestJson(token, `${pullRequestPath()}/merge`, {
					body: compact({ message: value.message }),
					method: "POST",
					query: { version: value.version },
				});
			case "decline_pull_request":
				return this.requestJson(token, `${pullRequestPath()}/decline`, {
					method: "POST",
					query: { version: value.version },
				});
			case "approve_pull_request":
				return this.requestJson(token, `${pullRequestPath()}/approve`, {
					method: "POST",
				});
			case "unapprove_pull_request":
				return this.requestJson(token, `${pullRequestPath()}/approve`, {
					method: "DELETE",
				});
			case "list_pull_request_comments":
				return this.requestJson(token, `${pullRequestPath()}/comments`, {
					query: pagination(value),
				});
			case "get_pull_request_comment":
				return this.requestJson(token, commentPath());
			case "create_pull_request_comment":
				return this.requestJson(token, `${pullRequestPath()}/comments`, {
					body: { text: value.content },
					method: "POST",
				});
			case "reply_pull_request_comment":
				return this.requestJson(token, `${pullRequestPath()}/comments`, {
					body: {
						parent: { id: value.commentId },
						text: value.content,
					},
					method: "POST",
				});
			case "update_pull_request_comment":
				return this.requestJson(token, commentPath(), {
					body: { text: value.content, version: value.version },
					method: "PUT",
				});
			case "delete_pull_request_comment":
				return this.requestJson(token, commentPath(), {
					method: "DELETE",
					query: { version: value.version },
				});
			default:
				throw providerError(`Unsupported Bitbucket Server action: ${action}`);
		}
	}

	private requestJson(
		accessToken: string,
		path: string,
		options: RequestOptions = {},
	) {
		return requestJson(this.fetcher, accessToken, path, options);
	}

	private requestText(
		accessToken: string,
		path: string,
		options: RequestOptions = {},
	) {
		return requestText(this.fetcher, accessToken, path, options);
	}
}

function projectPath(value: JsonObject) {
	return `/rest/api/1.0/projects/${segment(value, "project")}`;
}

function repositoryPath(value: JsonObject) {
	return `${projectPath(value)}/repos/${segment(value, "repository")}`;
}

function branchReference(value: JsonObject, key: string) {
	return {
		id: `refs/heads/${stringValue(value, key)}`,
		repository: {
			project: { key: stringValue(value, "project") },
			slug: stringValue(value, "repository"),
		},
	};
}

function pagination(value: JsonObject) {
	return compact({ limit: value.limit, start: value.start });
}

function segment(value: JsonObject, key: string) {
	return encodeURIComponent(stringValue(value, key));
}

function stringValue(value: JsonObject, key: string) {
	const entry = value[key];
	if (typeof entry !== "string" || !entry) {
		throw new Error(`${key} is required`);
	}
	return entry;
}

function integer(value: JsonObject, key: string) {
	const entry = value[key];
	if (!Number.isSafeInteger(entry) || Number(entry) < 0) {
		throw new Error(`${key} is invalid`);
	}
	return Number(entry);
}

function stringArray(value: unknown): string[] {
	return Array.isArray(value)
		? value.filter((entry): entry is string => typeof entry === "string")
		: [];
}

function compact(value: JsonObject) {
	return Object.fromEntries(
		Object.entries(value).filter(([, entry]) => entry !== undefined),
	);
}

function objectValue(value: unknown, key: string): JsonObject {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		return {};
	const entry = (value as JsonObject)[key];
	return typeof entry === "object" && entry !== null && !Array.isArray(entry)
		? (entry as JsonObject)
		: {};
}

function readString(value: unknown, key: string) {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		return undefined;
	const entry = (value as JsonObject)[key];
	return typeof entry === "string" ? entry : undefined;
}

function pageValues(value: unknown): JsonObject[] {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		return [];
	const values = (value as JsonObject).values;
	return Array.isArray(values)
		? values.filter(
				(entry): entry is JsonObject =>
					typeof entry === "object" && entry !== null && !Array.isArray(entry),
			)
		: [];
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
	accessToken: string,
	path: string,
	options: RequestOptions = {},
): Promise<JsonObject> {
	const response = await request(fetcher, accessToken, path, options);
	if (response.status === 204) return { ok: true };
	const text = await boundedText(response);
	try {
		const value: unknown = JSON.parse(text);
		if (typeof value !== "object" || value === null || Array.isArray(value)) {
			throw new Error("not an object");
		}
		return value as JsonObject;
	} catch {
		throw providerError("Bitbucket Server returned an invalid JSON response");
	}
}

async function requestText(
	fetcher: typeof fetch,
	accessToken: string,
	path: string,
	options: RequestOptions = {},
) {
	return boundedText(await request(fetcher, accessToken, path, options));
}

async function request(
	fetcher: typeof fetch,
	accessToken: string,
	path: string,
	options: RequestOptions,
) {
	if (!path.startsWith("/") || path.startsWith("//")) {
		throw providerError("Bitbucket Server request path is invalid");
	}
	const url = new URL(path, apiOrigin);
	if (options.query) {
		for (const [key, value] of Object.entries(options.query)) {
			if (
				typeof value === "string" ||
				typeof value === "number" ||
				typeof value === "boolean"
			) {
				url.searchParams.set(key, String(value));
			}
		}
	}
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
	try {
		const response = await fetcher(url, {
			body:
				options.body === undefined ? undefined : JSON.stringify(options.body),
			headers: {
				accept: "application/json, text/plain;q=0.9",
				authorization: `Bearer ${accessToken}`,
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
		) {
			throw invalidCredential("Bitbucket PAT was rejected");
		}
		if (!response.ok) {
			throw providerError(
				`Bitbucket Server request failed (${response.status})`,
			);
		}
		return response;
	} catch (error) {
		if (
			typeof error === "object" &&
			error !== null &&
			(error as { providerCredentialInvalid?: unknown })
				.providerCredentialInvalid === true
		) {
			throw error;
		}
		if (error instanceof Error && error.message.startsWith("Bitbucket Server"))
			throw error;
		throw providerError("Bitbucket Server request failed");
	} finally {
		clearTimeout(timeout);
	}
}

async function boundedText(response: Response) {
	const declaredLength = Number(response.headers.get("content-length") ?? 0);
	if (declaredLength > maxResponseBytes) {
		throw providerError("Bitbucket Server response is too large");
	}
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
				throw providerError("Bitbucket Server response is too large");
			}
			chunks.push(value);
		}
		if (timedOut) {
			throw providerError("Bitbucket Server response timed out");
		}
	} catch (error) {
		if (timedOut) {
			throw providerError("Bitbucket Server response timed out");
		}
		if (error instanceof Error && error.message.startsWith("Bitbucket Server"))
			throw error;
		throw providerError("Bitbucket Server response timed out");
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
