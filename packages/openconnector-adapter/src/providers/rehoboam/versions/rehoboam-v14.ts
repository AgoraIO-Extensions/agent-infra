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
		"为发布族每个环节记录研发交接/处理进度，包括自动 Job、人工合并 PR、提测/结果确认、决策及交付。先通过授权工具诊断；需要改源码时默认交给项目研发，除非用户明确要求代改，不要求用户声明是否有本地仓库。先 READ get_release_family 获取当前 revision/template_signature/任务，明确确认后记录；已结束任务需先恢复。resolved表示研发处理完成待用户确认，只需处理结果链接；源码编译阶段关联PR、完整提交及编译链接。这些是操作人提供的证据，不是系统PR/制品核验。不推进、不改原Job/申请、不通知、不合并、不运行。编译通过不等于合并或制品构建；仍由用户决定后续操作。结果不确定先READ核对，不盲重试。",
	effect: "WRITE",
	requiredScopes: ["rehoboam.release.write"],
	inputSchema: {
		type: "object",
		additionalProperties: false,
		anyOf: [
			{ properties: { stage: { enum: ["awaiting_developer", "fixing"] } } },
			{
				properties: { stage: { const: "resolved" } },
				required: ["validationUrl"],
			},
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
					"resolved",
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

export const continuationAction = {
	name: "rehoboam.get_release_family_continuation",
	id: "rehoboam.get_release_family_continuation@v14",
	description:
		"只读获取成员的剩余确认/最终交付步骤、按当前模板计数分隔符和步长生成的补发版本建议及受影响下游。Iris包完成后应明确引导核对结果、确认推进并预览最终交付，完成通知后再读取核对完结。需要新一轮Iris时用建议填入原preview_release_family，提供replacesMemberId并确认；旧成员/申请/Job保留，Unity等下游明确选择新产物后重新预览，不自动改旧参数或重跑。建议不占用版本号，未配置或查询不完整不猜测；Native锚点不可替换。不创建、不通知、不推进、不运行。",
	effect: "READ",
	requiredScopes: ["rehoboam.release.read"],
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["familyId", "memberId"],
		properties: { familyId: resourceId, memberId: resourceId },
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
					? `${old.description} 发布族每个环节都支持研发交接，包括Job、人工PR、提测、结果确认和交付。先诊断，需要改源码时默认交给项目研发，不要求用户声明本地仓库；用record_release_family_repair记录独立处理进度，不默认代改代码，不将编译通过视为合并或制品构建。Job处于ready_for_verification时展示结果，说明剩余确认/交付步骤并询问是否继续，不能闷着停留，也不自动完成或发通知。`
					: old.description,
		})),
		repairAction,
		continuationAction,
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
		const readOnly = input.action === continuationAction.name;
		if (!readOnly && input.action !== repairAction.name)
			return this.previous.execute(input);
		const data = input.input;
		if (
			!new Validator(
				(readOnly
					? continuationAction.inputSchema
					: repairAction.inputSchema) as unknown as Schema,
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
		const path =
			`/mcp/v1/release-families/${data.familyId}/members/${data.memberId}/` +
			(readOnly ? "continuation" : `tasks/${data.taskId}/record`);
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
					method: readOnly ? "GET" : "POST",
					redirect: "manual",
					headers: {
						accept: "application/json",
						"content-type": "application/json",
						apiKey: this.gatewayApiKey,
						authorization: `Bearer ${input.credential.accessToken}`,
						...(readOnly
							? {}
							: { "Idempotency-Key": String(data.idempotencyKey) }),
					},
					...(readOnly ? {} : { body: JSON.stringify(body) }),
				},
			);
		} catch {
			throw failure(
				"Repair submission outcome unknown; read the family before retrying",
				readOnly ? {} : { submissionUncertain: true },
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
				readOnly ? {} : { submissionUncertain: true },
			);
		}
		if (!response.ok) {
			const error = envelope.error as { code?: string } | undefined;
			throw failure("Repair record was not confirmed", {
				providerStatus: response.status,
				providerCode: error?.code,
				...(readOnly
					? {}
					: response.status < 500 && response.status !== 408
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
				...(readOnly ? {} : { submissionUncertain: true }),
			});
		return envelope.data as Record<string, unknown>;
	}
}
