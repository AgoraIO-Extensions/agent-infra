import type {
	CredentialForExecution,
	ProviderCredentialConnector,
	ProviderExecutor,
} from "@agent-infra/connection-core";
import {
	RehoboamV11Adapter,
	rehoboamV11ConnectionCatalog,
	rehoboamV11LegacyProviderReleaseIds,
} from "./rehoboam-v11.ts";
import { rehoboamV12ExecutorDigest } from "./rehoboam-v12-integrity.ts";

const anchorAction = {
	id: "rehoboam.get_release_family_native_anchor@v12",
	name: "rehoboam.get_release_family_native_anchor",
	description:
		"读取已有 Native 的套件、发布状态和 committed 发布族归属。已发布版本通过已有 preview/confirm、plans preview/initialize 沿用原交付；补发使用 restore preview/confirm，上游结果仍来自原版本。此查询不创建、不运行任何任务。",
	effect: "READ",
	requiredScopes: ["rehoboam.release.read"],
	inputSchema: {
		type: "object",
		required: ["releaseId"],
		properties: {
			releaseId: {
				type: "string",
				minLength: 1,
				maxLength: 128,
				pattern: "^(?!\\.{1,2}$)[\\s\\S]+$",
			},
		},
		additionalProperties: false,
	},
} as const;

const familyGuidance: Record<string, string> = {
	"rehoboam.preview_release_family":
		"已有 Native 已发布时先查询 native_anchor，用原 releaseId 作为 Native 成员；先检查已有发布族归属，避免重复创建。",
	"rehoboam.get_release_family":
		"inherited_delivery 表示沿用原 Native 交付，external_completed 不代表本次运行了 Job。",
	"rehoboam.initialize_release_family_plans":
		"初始化时由 Rehoboam 核对原 Native 状态；已发布 Native 沿用原交付，无待执行任务，其他平台正常初始化。不修改原版本或产物。",
	"rehoboam.restore_release_family_task":
		"需补发已发布 Native 时先预览恢复范围，再显式确认恢复指定任务；保留原交付记录，不直接运行 Job。",
};

export const rehoboamV12LegacyProviderReleaseIds = [
	"rehoboam-connection-v11",
	...rehoboamV11LegacyProviderReleaseIds,
] as const;
export const rehoboamV12ConnectionCatalog = {
	...rehoboamV11ConnectionCatalog,
	providerReleaseId: "rehoboam-connection-v12",
	sourceCommit: "connection-rehoboam-v12",
	executorDigest: rehoboamV12ExecutorDigest,
	actions: [
		...rehoboamV11ConnectionCatalog.actions.map((action) => ({
			...action,
			id: action.id.replace(/@v11$/, "@v12"),
			description: familyGuidance[action.name]
				? `${action.description} ${familyGuidance[action.name]}`
				: action.description,
		})),
		anchorAction,
	],
} as const;

export class RehoboamV12Adapter
	implements ProviderCredentialConnector, ProviderExecutor
{
	readonly providerId = "rehoboam";
	readonly providerReleaseId = "rehoboam-connection-v12";
	private readonly previous: RehoboamV11Adapter;
	private readonly fetcher: typeof fetch;
	private readonly gatewayApiKey: string;
	constructor(fetcher: typeof fetch, gatewayApiKey: string) {
		this.fetcher = fetcher;
		this.gatewayApiKey = gatewayApiKey;
		this.previous = new RehoboamV11Adapter(fetcher, gatewayApiKey);
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
	}) {
		if (input.action !== anchorAction.name) return this.previous.execute(input);
		const id = input.input.releaseId;
		if (
			Object.keys(input.input).some((key) => key !== "releaseId") ||
			typeof id !== "string" ||
			!id ||
			id.length > 128 ||
			id === "." ||
			id === ".."
		)
			throw Object.assign(new Error("Invalid Native release ID"), {
				providerError: true,
			});
		if (!input.credential.accessToken)
			throw Object.assign(new Error("Rehoboam token is required"), {
				providerError: true,
				providerStatus: 401,
			});
		const response = await this.fetcher(
			new URL(
				`/mcp/v1/release-families/native-anchors/${encodeURIComponent(id)}`,
				rehoboamV11ConnectionCatalog.deploymentProfile.apiOrigin,
			),
			{
				method: "GET",
				redirect: "manual",
				headers: {
					accept: "application/json",
					apiKey: this.gatewayApiKey,
					authorization: `Bearer ${input.credential.accessToken}`,
				},
			},
		);
		if (response.status >= 300 && response.status < 400)
			throw Object.assign(new Error("Rehoboam gateway rejected the request"), {
				providerError: true,
				providerStatus: 401,
			});
		const chunks: Uint8Array[] = [];
		let totalBytes = 0;
		const reader = response.body?.getReader();
		if (reader) {
			try {
				while (true) {
					const { done, value } = await reader.read();
					if (done) break;
					totalBytes += value.byteLength;
					if (totalBytes > 64 * 1024) {
						await reader.cancel().catch(() => {});
						throw Object.assign(new Error("Rehoboam response is too large"), {
							providerError: true,
						});
					}
					chunks.push(value);
				}
			} finally {
				reader.releaseLock();
			}
		}
		const raw = Buffer.concat(chunks, totalBytes).toString("utf8");
		let envelope: {
			data?: Record<string, unknown>;
			error?: Record<string, unknown>;
		};
		try {
			envelope = JSON.parse(raw);
		} catch {
			throw Object.assign(new Error("Rehoboam returned invalid JSON"), {
				providerError: true,
			});
		}
		if (!envelope || typeof envelope !== "object" || Array.isArray(envelope))
			throw Object.assign(new Error("Rehoboam returned invalid JSON"), {
				providerError: true,
			});
		if (!response.ok)
			throw Object.assign(new Error("Rehoboam Native anchor query failed"), {
				providerError: true,
				providerStatus: response.status,
				providerCode: envelope.error?.code,
				providerMessage: envelope.error?.message,
				providerDetails: envelope.error?.details,
				providerRetryable: envelope.error?.retryable,
				providerSubmissionOutcome: envelope.error?.submission_outcome,
			});
		if (
			!envelope.data ||
			typeof envelope.data !== "object" ||
			Array.isArray(envelope.data)
		)
			throw Object.assign(new Error("Rehoboam response is missing data"), {
				providerError: true,
			});
		return envelope.data;
	}
}
