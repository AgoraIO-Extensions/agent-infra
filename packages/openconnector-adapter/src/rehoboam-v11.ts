import type {
	CredentialForExecution,
	ProviderCredentialConnector,
	ProviderExecutor,
} from "@agent-infra/connection-core";
import {
	RehoboamAdapter,
	rehoboamConnectionCatalog,
	rehoboamLegacyProviderReleaseIds,
} from "./rehoboam.ts";
import {
	managementRequest,
	rehoboamManagementActions,
} from "./rehoboam-management.ts";
import { rehoboamV11ExecutorDigest } from "./rehoboam-v11-integrity.ts";

export const rehoboamV11LegacyProviderReleaseIds = [
	"rehoboam-connection-v10",
	...rehoboamLegacyProviderReleaseIds,
] as const;
export const rehoboamV11ConnectionCatalog = {
	...rehoboamConnectionCatalog,
	providerReleaseId: "rehoboam-connection-v11",
	executorDigest: rehoboamV11ExecutorDigest,
	actions: [
		...rehoboamConnectionCatalog.actions.map((action) => ({
			...action,
			id: action.id.replace(/@v10$/, "@v11"),
		})),
		...rehoboamManagementActions,
	],
} as const;

function providerFailure(
	message: string,
	details: Record<string, unknown> = {},
) {
	return Object.assign(new Error(message), { providerError: true, ...details });
}

export class RehoboamV11Adapter
	implements ProviderCredentialConnector, ProviderExecutor
{
	readonly providerId = "rehoboam";
	readonly providerReleaseId = "rehoboam-connection-v11";
	private readonly legacy: RehoboamAdapter;
	private readonly fetcher: typeof fetch;
	private readonly gatewayApiKey: string;
	constructor(fetcher: typeof fetch, gatewayApiKey: string) {
		this.fetcher = fetcher;
		this.gatewayApiKey = gatewayApiKey;
		this.legacy = new RehoboamAdapter(fetcher, gatewayApiKey);
	}
	async validateCredential(accessToken: string) {
		return {
			...(await this.legacy.validateCredential(accessToken)),
			providerReleaseId: this.providerReleaseId,
		};
	}
	async execute(input: {
		action: string;
		credential: CredentialForExecution;
		input: Record<string, unknown>;
	}) {
		if (
			!rehoboamManagementActions.some((action) => action.name === input.action)
		)
			return this.legacy.execute(input);
		if (!input.credential.accessToken)
			throw providerFailure("Rehoboam token is required", {
				providerStatus: 401,
			});
		const { path, init } = managementRequest(input.action, input.input);
		const response = await this.fetcher(
			new URL(path, rehoboamConnectionCatalog.deploymentProfile.apiOrigin),
			{
				...init,
				redirect: "manual",
				headers: {
					accept: "application/json",
					apiKey: this.gatewayApiKey,
					authorization: `Bearer ${input.credential.accessToken}`,
					...init.headers,
				},
			},
		);
		if (response.status >= 300 && response.status < 400)
			throw providerFailure("Rehoboam gateway credential was rejected", {
				providerStatus: 401,
			});
		const raw = await response.text();
		if (Buffer.byteLength(raw) > 64 * 1024)
			throw providerFailure("Rehoboam response is too large", {
				providerStatus: response.status,
			});
		let envelope: Record<string, unknown>;
		try {
			envelope = JSON.parse(raw);
		} catch {
			throw providerFailure("Rehoboam returned invalid JSON", {
				providerStatus: response.status,
			});
		}
		if (!envelope || typeof envelope !== "object" || Array.isArray(envelope))
			throw providerFailure("Rehoboam returned invalid JSON", {
				providerStatus: response.status,
			});
		const error =
			envelope.error &&
			typeof envelope.error === "object" &&
			!Array.isArray(envelope.error)
				? (envelope.error as Record<string, unknown>)
				: {};
		if (!response.ok) {
			const uncertain =
				error.submission_outcome === "accepted" ||
				error.submission_outcome === "uncertain";
			throw providerFailure("Rehoboam management request failed", {
				providerStatus: response.status,
				providerCode: typeof error.code === "string" ? error.code : undefined,
				providerMessage:
					typeof error.message === "string" ? error.message : undefined,
				providerRetryable: error.retryable,
				providerSubmissionOutcome: error.submission_outcome,
				...(uncertain ? { submissionUncertain: true } : {}),
			});
		}
		if (
			!envelope.data ||
			typeof envelope.data !== "object" ||
			Array.isArray(envelope.data)
		)
			throw providerFailure("Rehoboam response is missing data", {
				providerStatus: response.status,
			});
		return envelope.data as Record<string, unknown>;
	}
}
