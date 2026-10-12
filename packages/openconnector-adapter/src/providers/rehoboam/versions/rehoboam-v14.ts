import type { CredentialForExecution } from "@agent-infra/connection-core";
import { type Schema, Validator } from "@cfworker/json-schema";
import {
	RehoboamV13Adapter,
	rehoboamV13ConnectionCatalog,
	rehoboamV13LegacyProviderReleaseIds,
} from "./rehoboam-v13.ts";
import { rehoboamV14ExecutorDigest } from "./rehoboam-v14-integrity.ts";

const resourceId = {
	type: "string",
	minLength: 1,
	maxLength: 128,
	pattern: "^(?!\\.{1,2}$)[A-Za-z0-9_-]+$",
};
export const repairAction = {
	name: "rehoboam.record_release_family_repair",
	id: "rehoboam.record_release_family_repair@v14",
	description:
		"为发布族失败的自动任务记录研发交接/修复进度。发版人不需要本地仓库；默认交给项目研发，不默认代改 SDK。先 READ get_release_family 获取当前 revision/template_signature/失败任务，明确确认后记录。关联研发邮箱、修复 PR、完整提交及编译链接；这些是操作人提供的证据，不是系统 PR/制品核验。不推进、不改原 Job/申请、不通知人员、不合并、不运行。编译通过不等于合并或制品构建；使用原任务入口重新执行。结果不确定先 READ 核对，不盲重试。",
	effect: "WRITE",
	requiredScopes: ["rehoboam.release.write"],
	inputSchema: {
		type: "object",
		additionalProperties: false,
		anyOf: [
			{ properties: { stage: { enum: ["awaiting_developer", "fixing"] } } },
			{ required: ["prUrl", "validationUrl", "sourceCommit"] },
		],
		required: [
			"familyId",
			"memberId",
			"taskId",
			"expectedRevision",
			"templateSignature",
			"stage",
			"note",
			"idempotencyKey",
		],
		properties: {
			familyId: resourceId,
			memberId: resourceId,
			taskId: resourceId,
			expectedRevision: { type: "integer", minimum: 0 },
			templateSignature: { type: "string", minLength: 1, maxLength: 128 },
			stage: {
				type: "string",
				enum: [
					"awaiting_developer",
					"fixing",
					"compile_passed",
					"waiting_merge",
					"ready_to_retry",
				],
			},
			developerEmail: { type: "string", maxLength: 1000 },
			prUrl: { type: "string", maxLength: 1000 },
			validationUrl: { type: "string", maxLength: 1000 },
			sourceCommit: { type: "string", pattern: "^[0-9a-fA-F]{40}$" },
			note: { type: "string", minLength: 1, maxLength: 4000 },
			idempotencyKey: { type: "string", minLength: 1, maxLength: 128 },
		},
	},
} as const;

export const rehoboamV14LegacyProviderReleaseIds = [
	"rehoboam-connection-v13",
	...rehoboamV13LegacyProviderReleaseIds,
] as const;
export const rehoboamV14ConnectionCatalog = {
	...rehoboamV13ConnectionCatalog,
	providerReleaseId: "rehoboam-connection-v14",
	sourceCommit: "connection-rehoboam-v14",
	executorDigest: rehoboamV14ExecutorDigest,
	actions: [
		...rehoboamV13ConnectionCatalog.actions.map((old) => ({
			...old,
			id: old.id.replace(/@v13$/, "@v14"),
			description:
				old.name === "rehoboam.get_release_family"
					? `${old.description} Job 失败时默认交给项目研发，发版人无需本地仓库；用 record_release_family_repair 记录独立修复进度，不默认代改代码，不将编译通过视为合并或制品构建。`
					: old.description,
		})),
		repairAction,
	],
} as const;

const failure = (message: string, details: Record<string, unknown> = {}) =>
	Object.assign(new Error(message), { providerError: true, ...details });

export class RehoboamV14Adapter {
	readonly providerId = "rehoboam";
	readonly providerReleaseId = "rehoboam-connection-v14";
	private readonly previous: RehoboamV13Adapter;
	private readonly fetcher: typeof fetch;
	private readonly gatewayApiKey: string;
	constructor(fetcher: typeof fetch, gatewayApiKey: string) {
		this.fetcher = fetcher;
		this.gatewayApiKey = gatewayApiKey;
		this.previous = new RehoboamV13Adapter(fetcher, gatewayApiKey);
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
	}): Promise<Record<string, unknown>> {
		if (input.action !== repairAction.name) return this.previous.execute(input);
		const data = input.input;
		if (
			!new Validator(
				repairAction.inputSchema as unknown as Schema,
				"2020-12",
				false,
			).validate(data).valid
		)
			throw failure("Invalid repair record", {
				providerStatus: 400,
				providerSubmissionOutcome: "rejected",
			});
		if (!input.credential.accessToken)
			throw failure("Rehoboam token is required", {
				providerCredentialInvalid: true,
				providerSubmissionOutcome: "rejected",
			});
		const path = `/mcp/v1/release-families/${data.familyId}/members/${data.memberId}/tasks/${data.taskId}/record`;
		const body = {
			expected_revision: data.expectedRevision,
			template_signature: data.templateSignature,
			disposition: "repair_progress",
			note: data.note,
			repair_progress: {
				stage: data.stage,
				developer_email: data.developerEmail,
				pr_url: data.prUrl,
				validation_url: data.validationUrl,
				source_commit: data.sourceCommit,
			},
		};
		let response: Response;
		try {
			response = await this.fetcher(
				new URL(path, rehoboamV14ConnectionCatalog.deploymentProfile.apiOrigin),
				{
					method: "POST",
					redirect: "manual",
					headers: {
						accept: "application/json",
						"content-type": "application/json",
						apiKey: this.gatewayApiKey,
						authorization: `Bearer ${input.credential.accessToken}`,
						"Idempotency-Key": String(data.idempotencyKey),
					},
					body: JSON.stringify(body),
				},
			);
		} catch {
			throw failure(
				"Repair submission outcome unknown; read the family before retrying",
				{ submissionUncertain: true },
			);
		}
		if (response.status >= 300 && response.status < 400)
			throw failure("Rehoboam gateway rejected the request", {
				providerStatus: 401,
				providerCredentialInvalid: true,
				providerSubmissionOutcome: "rejected",
			});
		let envelope: Record<string, unknown>;
		try {
			if (!response.body) throw new Error("empty body");
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
				"Repair response invalid; read the family before retrying",
				{ submissionUncertain: true },
			);
		}
		if (!response.ok) {
			const error = envelope.error as { code?: string } | undefined;
			throw failure("Repair record was not confirmed", {
				providerStatus: response.status,
				providerCode: error?.code,
				...(response.status < 500 && response.status !== 408
					? { providerSubmissionOutcome: "rejected" }
					: { submissionUncertain: true }),
				...(response.status === 401 ? { providerCredentialInvalid: true } : {}),
			});
		}
		if (
			!envelope.data ||
			typeof envelope.data !== "object" ||
			Array.isArray(envelope.data)
		)
			throw failure("Repair receipt missing; read the family before retrying", {
				submissionUncertain: true,
			});
		return envelope.data as Record<string, unknown>;
	}
}
