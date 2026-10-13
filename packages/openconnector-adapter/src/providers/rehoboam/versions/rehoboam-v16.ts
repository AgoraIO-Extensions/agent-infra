import type { CredentialForExecution } from "@agent-infra/connection-core";
import { type Schema, Validator } from "@cfworker/json-schema";
import {
	RehoboamV15Adapter,
	rehoboamV15ConnectionCatalog,
	rehoboamV15LegacyProviderReleaseIds,
} from "./rehoboam-v15.ts";
import { rehoboamV16ExecutorDigest } from "./rehoboam-v16-integrity.ts";

const text = (maxLength: number) => ({
	type: "string",
	minLength: 1,
	maxLength,
});
const hash = { type: "string", pattern: "^[0-9a-f]{64}$" };
const articleId = { ...text(64), pattern: "^[a-z0-9_-]+$" };
const schema = (
	properties: Record<string, unknown>,
	required: string[] = [],
) => ({ type: "object", additionalProperties: false, properties, required });
const candidateProperties = {
	title: text(160),
	scope: text(160),
	symptom: text(2000),
	conditions: text(2000),
	resolution: text(4000),
	reportedVerification: text(2000),
	limitations: text(2000),
	contentHash: hash,
	evidenceUrls: { type: "array", minItems: 1, maxItems: 8, items: text(2048) },
	relatedArticleIds: { type: "array", maxItems: 8, items: articleId },
	idempotencyKey: { ...text(128), pattern: "^[!-~]+$" },
};
export const helpActions = [
	{
		name: "rehoboam.search_pipeline_help",
		description:
			"检索已发布的发布族帮助，匹配正文与对话，按适用链路分页返回文章索引和 content_hash。先查帮助再解释流程或排障，文章不代表执行授权；当前模板/权限/状态为准。完整内容用 get_pipeline_help_article 读取，不把知识候选当正式规则。",
		effect: "READ",
		requiredScopes: ["rehoboam.metadata.read"],
		inputSchema: schema({
			query: { type: "string", maxLength: 256 },
			scope: text(160),
			offset: { type: "integer", minimum: 0, maximum: 10000 },
			limit: { type: "integer", minimum: 1, maximum: 20 },
		}),
	},
	{
		name: "rehoboam.get_pipeline_help_article",
		description:
			"读取已发布帮助文章全文、适用范围和内容版本，引用返回的页面链接。帮助是参考知识，不替代当前模板、权限及操作预览，不执行发布。",
		effect: "READ",
		requiredScopes: ["rehoboam.metadata.read"],
		inputSchema: schema({ articleId }, ["articleId"]),
	},
	{
		name: "rehoboam.submit_pipeline_help_candidate",
		description:
			"明确用户意图后，将已解决问题整理为待审核知识候选。先检索帮助去重并携带 content_hash，注明链路、现象、触发条件、处理步骤、提交人报告的验证、证据链接和限制。证据不得包含凭据/查询参数/片段；不会抓取链接。候选 published=false，仅保存记录，不改帮助/模板/权限/Job，不通知或自动发布。总请求最多16 KiB；幂等键稳定，同键不同内容拒绝。未知结果用原键回读/核对，不能改键重复提交。维护者核验后通过帮助更新 PR、合并部署生效。",
		effect: "WRITE",
		requiredScopes: ["rehoboam.release.write"],
		inputSchema: schema(candidateProperties, Object.keys(candidateProperties)),
	},
	{
		name: "rehoboam.get_pipeline_help_candidate",
		description:
			"按回执 ID 回读知识候选，仅本人或当前管理员可读。proposed/submitter_reported 不表示已核验或已发布；待维护者审核并经 PR 部署后生效。不产生任何写入或发布。",
		effect: "READ",
		requiredScopes: ["rehoboam.release.read"],
		inputSchema: schema({ candidateId: hash }, ["candidateId"]),
	},
].map((action) => ({ ...action, id: `${action.name}@v16` })) as Array<{
	name: string;
	id: string;
	description: string;
	effect: "READ" | "WRITE";
	requiredScopes: string[];
	inputSchema: ReturnType<typeof schema>;
}>;

export const rehoboamV16LegacyProviderReleaseIds = [
	"rehoboam-connection-v15",
	...rehoboamV15LegacyProviderReleaseIds,
] as const;
export const rehoboamV16ConnectionCatalog = {
	...rehoboamV15ConnectionCatalog,
	providerReleaseId: "rehoboam-connection-v16",
	sourceCommit: "connection-rehoboam-v16",
	executorDigest: rehoboamV16ExecutorDigest,
	actions: [
		...rehoboamV15ConnectionCatalog.actions.map((old) => ({
			...old,
			id: old.id.replace(/@v15$/, "@v16"),
		})),
		...helpActions,
	],
} as const;
const failure = (message: string, details: Record<string, unknown> = {}) =>
	Object.assign(new Error(message), { providerError: true, ...details });

export class RehoboamV16Adapter {
	readonly providerId = "rehoboam";
	readonly providerReleaseId = "rehoboam-connection-v16";
	private readonly previous: RehoboamV15Adapter;
	private readonly fetcher: typeof fetch;
	private readonly gatewayApiKey: string;
	constructor(fetcher: typeof fetch, gatewayApiKey: string) {
		this.fetcher = fetcher;
		this.gatewayApiKey = gatewayApiKey;
		this.previous = new RehoboamV15Adapter(fetcher, gatewayApiKey);
	}
	async validateCredential(token: string) {
		return {
			...(await this.previous.validateCredential(token)),
			providerReleaseId: this.providerReleaseId,
		};
	}
	async execute(input: {
		action: string;
		credential: CredentialForExecution;
		input: Record<string, unknown>;
		actionVersionId?: string;
		providerReleaseId?: string;
	}): Promise<Record<string, unknown>> {
		const action = helpActions.find((action) => action.name === input.action);
		if (!action) {
			if (
				input.providerReleaseId === this.providerReleaseId ||
				input.actionVersionId?.endsWith("@v16")
			) {
				const current = rehoboamV16ConnectionCatalog.actions.find(
					(item) => item.name === input.action,
				);
				if (
					!current ||
					(input.providerReleaseId &&
						input.providerReleaseId !== this.providerReleaseId) ||
					(input.actionVersionId && input.actionVersionId !== current.id) ||
					!new Validator(
						current.inputSchema as unknown as Schema,
						"2020-12",
						false,
					).validate(input.input).valid
				)
					throw failure("Invalid v16 action binding", {
						providerStatus: 400,
						providerSubmissionOutcome: "rejected",
					});
				return this.previous.execute({
					...input,
					actionVersionId: undefined,
					providerReleaseId: undefined,
				});
			}
			return this.previous.execute(input);
		}
		const write = action.effect === "WRITE";
		if (
			(input.actionVersionId && input.actionVersionId !== action.id) ||
			(input.providerReleaseId &&
				input.providerReleaseId !== this.providerReleaseId) ||
			!new Validator(action.inputSchema as Schema, "2020-12", false).validate(
				input.input,
			).valid
		)
			throw failure("Invalid help action input", {
				providerStatus: 400,
				providerSubmissionOutcome: "rejected",
			});
		if (!input.credential.accessToken)
			throw failure("Rehoboam token is required", {
				providerCredentialInvalid: true,
				providerSubmissionOutcome: "rejected",
			});
		const data = input.input;
		const url = new URL(
			"/mcp/v1/pipeline-help",
			rehoboamV16ConnectionCatalog.deploymentProfile.apiOrigin,
		);
		let body: Record<string, unknown> | undefined;
		if (input.action === "rehoboam.get_pipeline_help_article")
			url.pathname += `/articles/${data.articleId}`;
		else if (input.action === "rehoboam.get_pipeline_help_candidate")
			url.pathname += `/candidates/${data.candidateId}`;
		else if (write) {
			url.pathname += "/candidates";
			body = {
				title: data.title,
				scope: data.scope,
				symptom: data.symptom,
				conditions: data.conditions,
				resolution: data.resolution,
				reported_verification: data.reportedVerification,
				limitations: data.limitations,
				content_hash: data.contentHash,
				evidence_urls: data.evidenceUrls,
				related_article_ids: data.relatedArticleIds,
			};
			if (Buffer.byteLength(JSON.stringify(body)) > 16384)
				throw failure("Candidate exceeds 16 KiB; shorten the report", {
					providerStatus: 413,
					providerSubmissionOutcome: "rejected",
				});
		} else
			for (const [key, value] of Object.entries(data))
				url.searchParams.set(key, String(value));
		let response: Response;
		try {
			response = await this.fetcher(url, {
				method: write ? "POST" : "GET",
				redirect: "manual",
				signal: AbortSignal.timeout(30_000),
				headers: {
					accept: "application/json",
					apiKey: this.gatewayApiKey,
					authorization: `Bearer ${input.credential.accessToken}`,
					...(write
						? {
								"content-type": "application/json",
								"Idempotency-Key": String(data.idempotencyKey),
							}
						: {}),
				},
				...(body ? { body: JSON.stringify(body) } : {}),
			});
		} catch {
			throw failure(
				"Help request failed; for writes read back or reuse the same key, never create a new key",
				write ? { submissionUncertain: true } : { providerRetryable: true },
			);
		}
		if (response.status >= 300 && response.status < 400)
			throw failure("Rehoboam gateway rejected the request", {
				providerStatus: 502,
				providerCode: "GATEWAY_REDIRECT",
				...(write ? { submissionUncertain: true } : {}),
			});
		let envelope: {
			success?: boolean;
			data?: Record<string, unknown>;
			error?: { code?: string; submission_outcome?: string };
		};
		try {
			if (!response.body) throw new Error("missing body");
			const reader = response.body.getReader();
			const chunks: Uint8Array[] = [];
			let size = 0;
			try {
				while (true) {
					const { done, value } = await reader.read();
					if (done) break;
					size += value.byteLength;
					if (size > 65536) {
						await reader.cancel();
						throw new Error("size");
					}
					chunks.push(value);
				}
			} finally {
				reader.releaseLock();
			}
			envelope = JSON.parse(Buffer.concat(chunks, size).toString("utf8"));
			if (!envelope || typeof envelope !== "object" || Array.isArray(envelope))
				throw new Error("shape");
		} catch {
			throw failure(
				"Invalid or oversized help response",
				write ? { submissionUncertain: true } : { providerStatus: 502 },
			);
		}
		if (!response.ok || envelope.success !== true)
			throw failure("Rehoboam rejected help action", {
				providerStatus: response.status,
				...(response.status === 401 ? { providerCredentialInvalid: true } : {}),
				...(typeof envelope.error?.code === "string" &&
				/^[A-Z_]{1,64}$/.test(envelope.error.code)
					? { providerCode: envelope.error.code }
					: {}),
				...(write
					? envelope.error?.submission_outcome === "rejected" ||
						(response.status < 500 && ![408, 413].includes(response.status))
						? { providerSubmissionOutcome: "rejected" }
						: { submissionUncertain: true }
					: {}),
			});
		const result = envelope.data;
		if (!result || typeof result !== "object" || Array.isArray(result))
			throw failure(
				"Help receipt missing",
				write ? { submissionUncertain: true } : { providerStatus: 502 },
			);
		if (
			write &&
			(result.status !== "proposed" ||
				result.published !== false ||
				result.verification_status !== "submitter_reported" ||
				!/^[0-9a-f]{64}$/.test(String(result.id)))
		)
			throw failure("Candidate receipt invalid; read back before retrying", {
				submissionUncertain: true,
			});
		if (write) {
			const candidate = result.candidate as Record<string, unknown> | undefined;
			if (
				!candidate ||
				!body ||
				typeof result.owner !== "string" ||
				!result.owner ||
				typeof result.create_time !== "number" ||
				Object.entries(body).some(
					([key, value]) =>
						JSON.stringify(candidate[key]) !==
						JSON.stringify(
							typeof value === "string"
								? value.trim()
								: Array.isArray(value)
									? [...new Set(value)]
									: value,
						),
				)
			)
				throw failure(
					"Candidate content receipt differs; read back before retrying",
					{ submissionUncertain: true },
				);
		}
		if (!write) {
			if (input.action === "rehoboam.get_pipeline_help_candidate") {
				if (
					result.id !== data.candidateId ||
					result.status !== "proposed" ||
					result.published !== false ||
					result.verification_status !== "submitter_reported"
				)
					throw failure("Candidate read receipt invalid", {
						providerStatus: 502,
					});
			} else {
				if (!/^[0-9a-f]{64}$/.test(String(result.content_hash)))
					throw failure("Help version missing", { providerStatus: 502 });
				if (
					input.action === "rehoboam.get_pipeline_help_article" &&
					(result.article as { id?: unknown } | undefined)?.id !==
						data.articleId
				)
					throw failure("Help article differs from requested ID", {
						providerStatus: 502,
					});
				if (
					input.action === "rehoboam.search_pipeline_help" &&
					(!Array.isArray(result.items) ||
						result.items.length > Number(data.limit ?? 10))
				)
					throw failure("Help search page invalid", { providerStatus: 502 });
			}
		}
		return result;
	}
}
