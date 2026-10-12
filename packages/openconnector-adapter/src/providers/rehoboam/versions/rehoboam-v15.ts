import type { CredentialForExecution } from "@agent-infra/connection-core";
import { type Schema, Validator } from "@cfworker/json-schema";
import {
	RehoboamV14Adapter,
	rehoboamV14ConnectionCatalog,
	rehoboamV14LegacyProviderReleaseIds,
} from "./rehoboam-v14.ts";
import { rehoboamV15ExecutorDigest } from "./rehoboam-v15-integrity.ts";

export const cancelChannelPublishAction = {
	name: "rehoboam.cancel_channel_publish_request",
	id: "rehoboam.cancel_channel_publish_request@v15",
	description:
		"取消本人的渠道发布 / Publishing（channel_publishing）未获批申请，适用于 CDN/Maven/CocoaPods/SwiftPM/NPM；不是 Pipeline Center 撤回。先 READ get_channel_publish_request 核对明确任务、原申请人和状态，再取消。仅 NEW/WAITING_IN_APPROVEMENT 可取消；不需要审批资格，不取消他人申请，不中止已获批、排队或运行的 Job，不删除任务。保留取消人/时间/意见；同键重放返回原回执，取消与审批竞争只允许一方成功。未知结果先查询原任务，不自动重发。",
	effect: "WRITE",
	requiredScopes: ["rehoboam.publishing.write"],
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["releaseSystem", "taskId", "idempotencyKey"],
		properties: {
			releaseSystem: { type: "string", const: "channel_publishing" },
			taskId: { type: "string", pattern: "^[0-9a-f]{24}$" },
			idempotencyKey: {
				type: "string",
				minLength: 1,
				maxLength: 128,
				pattern: "^[!-~]+$",
			},
			comment: { type: "string", maxLength: 2000 },
		},
	},
} as const;

export const rehoboamV15LegacyProviderReleaseIds = [
	"rehoboam-connection-v14",
	...rehoboamV14LegacyProviderReleaseIds,
] as const;
export const rehoboamV15ConnectionCatalog = {
	...rehoboamV14ConnectionCatalog,
	providerReleaseId: "rehoboam-connection-v15",
	sourceCommit: "connection-rehoboam-v15",
	executorDigest: rehoboamV15ExecutorDigest,
	actions: [
		...rehoboamV14ConnectionCatalog.actions.map((old) => ({
			...old,
			id: old.id.replace(/@v14$/, "@v15"),
		})),
		cancelChannelPublishAction,
	],
} as const;

const failure = (message: string, details: Record<string, unknown> = {}) =>
	Object.assign(new Error(message), { providerError: true, ...details });

export class RehoboamV15Adapter {
	readonly providerId = "rehoboam";
	readonly providerReleaseId = "rehoboam-connection-v15";
	private readonly previous: RehoboamV14Adapter;
	private readonly fetcher: typeof fetch;
	private readonly gatewayApiKey: string;
	constructor(fetcher: typeof fetch, gatewayApiKey: string) {
		this.fetcher = fetcher;
		this.gatewayApiKey = gatewayApiKey;
		this.previous = new RehoboamV14Adapter(fetcher, gatewayApiKey);
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
		if (input.action !== cancelChannelPublishAction.name)
			return this.previous.execute(input);
		if (
			(input.actionVersionId &&
				input.actionVersionId !== cancelChannelPublishAction.id) ||
			(input.providerReleaseId &&
				input.providerReleaseId !== this.providerReleaseId) ||
			!new Validator(
				cancelChannelPublishAction.inputSchema as unknown as Schema,
				"2020-12",
				false,
			).validate(input.input).valid
		)
			throw failure("Invalid channel cancellation input", {
				providerStatus: 400,
				providerSubmissionOutcome: "rejected",
			});
		if (!input.credential.accessToken)
			throw failure("Rehoboam token is required", {
				providerStatus: 401,
				providerCredentialInvalid: true,
				providerSubmissionOutcome: "rejected",
			});
		const data = input.input;
		let response: Response;
		try {
			response = await this.fetcher(
				new URL(
					`/api/v1/channel-publishing/requests/${data.taskId}/cancellation`,
					rehoboamV15ConnectionCatalog.deploymentProfile.apiOrigin,
				),
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
					body: JSON.stringify({
						release_system: data.releaseSystem,
						comment: data.comment ?? "",
					}),
				},
			);
		} catch {
			throw failure(
				"Cancellation outcome unknown; query the task before retrying",
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
				"Cancellation response invalid; query the task before retrying",
				{ providerStatus: response.status, submissionUncertain: true },
			);
		}
		if (!response.ok) {
			const error = envelope.error as { code?: unknown } | undefined;
			throw failure("Cancellation was not confirmed", {
				providerStatus: response.status,
				...(typeof error?.code === "string" &&
				/^[A-Z][A-Z0-9_]{0,63}$/.test(error.code)
					? { providerCode: error.code }
					: {}),
				...(response.status < 500 && ![408, 413].includes(response.status)
					? { providerSubmissionOutcome: "rejected" }
					: { submissionUncertain: true }),
				...(response.status === 401 ? { providerCredentialInvalid: true } : {}),
			});
		}
		const audit = envelope.cancellation as Record<string, unknown> | undefined;
		if (
			envelope.release_system !== "channel_publishing" ||
			envelope.task_id !== data.taskId ||
			envelope.status !== "CANCELLED" ||
			!audit ||
			typeof audit.actor !== "string" ||
			!audit.actor ||
			typeof audit.at !== "number"
		)
			throw failure(
				"Cancellation receipt missing; query the task before retrying",
				{ submissionUncertain: true },
			);
		return envelope;
	}
}
