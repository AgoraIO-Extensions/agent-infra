import type {
	CredentialForExecution,
	ProviderCredentialConnector,
	ProviderExecutor,
} from "@agent-infra/connection-core";
import { rehoboamExecutorDigest } from "./rehoboam-integrity.ts";

const apiOrigin = "https://justinia.gz3.agoralab.co";
const credentialScope = "rehoboam.read";
const maxResponseBytes = 64 * 1024;
const providerId = "rehoboam";
const providerReleaseId = "rehoboam-connection-v1";

export const rehoboamConnectionCatalog = {
	actions: [
		{
			description: "获取当前通过 Rehoboam 个人 Token 鉴权的用户。",
			effect: "READ" as const,
			id: "rehoboam.get_current_user@v1",
			inputSchema: {
				additionalProperties: false,
				properties: {},
				required: [],
				type: "object",
			},
			name: "rehoboam.get_current_user",
			requiredScopes: [credentialScope],
		},
	],
	authProfile: {
		gatewayHeader: "apiKey",
		personalCredential: "bearer-token",
	},
	deploymentProfile: {
		apiOrigin,
		deployment: "company-managed",
		identity: "GET /api/connection/whoami",
		product: "Rehoboam",
	},
	executorDigest: rehoboamExecutorDigest,
	provider: providerId,
	providerReleaseId,
	sourceCommit: "connection-native",
} as const;

export class RehoboamAdapter
	implements ProviderCredentialConnector, ProviderExecutor
{
	readonly providerId = providerId;
	readonly providerReleaseId = providerReleaseId;
	private readonly fetcher: typeof fetch;
	private readonly gatewayApiKey: string;

	constructor(fetcher: typeof fetch, gatewayApiKey: string) {
		this.fetcher = fetcher;
		this.gatewayApiKey = gatewayApiKey;
	}

	async validateCredential(accessToken: string) {
		const identity = await this.getCurrentUser(accessToken);
		return {
			accessToken,
			displayName: identity.username,
			externalAccount: identity.user_id,
			grantedScopes: [credentialScope],
			providerId,
			providerReleaseId,
		};
	}

	async execute(input: {
		action: string;
		credential: CredentialForExecution;
		input: Record<string, unknown>;
	}) {
		if (input.action !== "rehoboam.get_current_user") {
			throw providerError(`Unsupported Rehoboam action: ${input.action}`);
		}
		return this.getCurrentUser(input.credential.accessToken);
	}

	private async getCurrentUser(accessToken: string) {
		if (!accessToken) throw invalidCredential("Rehoboam token is required");
		const response = await this.fetcher(
			new URL("/api/connection/whoami", apiOrigin),
			{
				headers: {
					accept: "application/json",
					apiKey: this.gatewayApiKey,
					authorization: `Bearer ${accessToken}`,
				},
				redirect: "manual",
			},
		);
		if (response.status === 401 || response.status === 403) {
			throw invalidCredential("Rehoboam credential was rejected");
		}
		if (response.status >= 300 && response.status < 400) {
			throw invalidCredential("Rehoboam gateway credential was rejected");
		}
		if (!response.ok) {
			throw providerError(
				`Rehoboam request failed with HTTP ${response.status}`,
			);
		}
		const text = await response.text();
		if (Buffer.byteLength(text) > maxResponseBytes) {
			throw providerError("Rehoboam response is too large");
		}
		let envelope: unknown;
		try {
			envelope = JSON.parse(text);
		} catch {
			throw providerError("Rehoboam returned invalid JSON");
		}
		const data =
			envelope && typeof envelope === "object" && "data" in envelope
				? (envelope.data as Record<string, unknown>)
				: undefined;
		const userId = typeof data?.user_id === "string" ? data.user_id : "";
		const username = typeof data?.username === "string" ? data.username : "";
		const role = typeof data?.role === "string" ? data.role : null;
		if (!userId || !username) {
			throw invalidCredential("Rehoboam identity is incomplete");
		}
		return { role, user_id: userId, username };
	}
}

function invalidCredential(message: string) {
	return Object.assign(new Error(message), { providerCredentialInvalid: true });
}

function providerError(message: string) {
	return Object.assign(new Error(message), { providerFailure: true });
}
