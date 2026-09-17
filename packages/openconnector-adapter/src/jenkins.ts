import type {
	CredentialForExecution,
	ProviderCredentialConnector,
	ProviderExecutor,
} from "@agent-infra/connection-core";

import { jenkinsExecutorDigest } from "./jenkins-integrity.ts";

const credentialScope = "jenkins.read";
const maxResponseBytes = 5 * 1024 * 1024;
const requestTimeoutMs = 8_000;
const sourceCommit = "connection-native";

type JsonObject = Record<string, unknown>;

export type JenkinsDeploymentProfile = {
	apiOrigin: `http://${string}` | `https://${string}`;
	displayName: string;
	providerId: `jenkins-${string}`;
};

export const jenkinsCiProfile = {
	apiOrigin: "https://jenkins-ci.agoralab.co",
	displayName: "Jenkins CI",
	providerId: "jenkins-ci",
} as const satisfies JenkinsDeploymentProfile;

export const jenkinsReleaseProfile = {
	apiOrigin: "http://114.94.148.35:8010",
	displayName: "Jenkins Release",
	providerId: "jenkins-release",
} as const satisfies JenkinsDeploymentProfile;

const actionSpecs = [
	{
		description: "获取当前通过公司 Jenkins API Token 鉴权的用户。",
		name: "get_current_user",
		properties: {},
		required: [],
	},
	{
		description: "列出当前用户可见的 Jenkins 顶层 Job。",
		name: "list_jobs",
		properties: {},
		required: [],
	},
	{
		description: "按完整名称获取 Jenkins Job。",
		name: "get_job",
		properties: { jobFullName: { minLength: 1, type: "string" } },
		required: ["jobFullName"],
	},
	{
		description: "按 Job 完整名称和构建编号获取 Jenkins Build。",
		name: "get_build",
		properties: {
			buildNumber: { minimum: 1, type: "integer" },
			jobFullName: { minLength: 1, type: "string" },
		},
		required: ["jobFullName", "buildNumber"],
	},
	{
		description: "按 Queue item ID 获取 Jenkins 排队状态。",
		name: "get_queue_item",
		properties: { queueItemId: { minimum: 1, type: "integer" } },
		required: ["queueItemId"],
	},
] as const;

export function createJenkinsConnectionCatalog(
	profile: JenkinsDeploymentProfile,
) {
	return {
		actions: actionSpecs.map((action) => ({
			description: action.description,
			effect: "READ" as const,
			id: `${profile.providerId}.${action.name}@v1`,
			inputSchema: {
				additionalProperties: false,
				properties: action.properties,
				required: [...action.required],
				type: "object",
			},
			name: `${profile.providerId}.${action.name}`,
			requiredScopes: [credentialScope],
		})),
		authProfile: {
			credential: "username-and-api-token",
			header: "Authorization",
			scheme: "Basic",
		},
		deploymentProfile: {
			apiOrigin: profile.apiOrigin,
			deployment: "company-managed",
			identity: "GET /whoAmI/api/json authenticated non-anonymous name",
			product: "Jenkins",
		},
		executorDigest: jenkinsExecutorDigest,
		provider: profile.providerId,
		providerReleaseId: `${profile.providerId}-connection-v1`,
		sourceCommit,
	} as const;
}

export const jenkinsCiConnectionCatalog =
	createJenkinsConnectionCatalog(jenkinsCiProfile);
export const jenkinsReleaseConnectionCatalog = createJenkinsConnectionCatalog(
	jenkinsReleaseProfile,
);

export class JenkinsAdapter
	implements ProviderCredentialConnector, ProviderExecutor
{
	readonly providerId: string;
	readonly providerReleaseId: string;
	private readonly fetcher: typeof fetch;
	private readonly profile: JenkinsDeploymentProfile;

	constructor(profile: JenkinsDeploymentProfile, fetcher: typeof fetch) {
		this.profile = profile;
		this.fetcher = fetcher;
		this.providerId = profile.providerId;
		this.providerReleaseId =
			createJenkinsConnectionCatalog(profile).providerReleaseId;
	}

	async validateCredential(encodedCredential: string) {
		const credential = parseCredential(encodedCredential);
		const identity = await this.requestJson(
			credential,
			"/whoAmI/api/json",
			true,
		);
		const externalAccount = stringValue(identity, "name");
		if (
			!externalAccount ||
			identity.authenticated !== true ||
			identity.anonymous === true
		) {
			throw invalidCredential("Jenkins identity is missing or anonymous");
		}
		return {
			accessToken: encodedCredential,
			displayName: externalAccount,
			externalAccount,
			grantedScopes: [credentialScope],
			providerId: this.providerId,
			providerReleaseId: this.providerReleaseId,
		};
	}

	async execute(input: {
		action: string;
		credential: CredentialForExecution;
		input: JsonObject;
	}) {
		const credential = parseCredential(input.credential.accessToken);
		const action = input.action.replace(`${this.providerId}.`, "");
		switch (action) {
			case "get_current_user": {
				const { accessToken: _accessToken, ...identity } =
					await this.validateCredential(input.credential.accessToken);
				return identity;
			}
			case "list_jobs":
				return this.requestJson(credential, "/api/json");
			case "get_job":
				return this.requestJson(credential, `${jobPath(input.input)}/api/json`);
			case "get_build":
				return this.requestJson(
					credential,
					`${jobPath(input.input)}/${positiveInteger(input.input, "buildNumber")}/api/json`,
				);
			case "get_queue_item":
				return this.requestJson(
					credential,
					`/queue/item/${positiveInteger(input.input, "queueItemId")}/api/json`,
				);
			default:
				throw providerError(`Unsupported Jenkins action: ${action}`);
		}
	}

	private async requestJson(
		credential: JenkinsCredential,
		path: string,
		credentialProbe = false,
	) {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
		try {
			const response = await this.fetcher(
				new URL(path, this.profile.apiOrigin),
				{
					headers: {
						accept: "application/json",
						authorization: `Basic ${Buffer.from(`${credential.username}:${credential.apiToken}`).toString("base64")}`,
					},
					redirect: "manual",
					signal: controller.signal,
				},
			);
			if (response.status === 401 || response.status === 403) {
				throw invalidCredential("Jenkins credential was rejected");
			}
			if (response.status >= 300 && response.status < 400) {
				throw credentialProbe
					? invalidCredential("Jenkins credential validation redirected")
					: providerError("Jenkins request redirected");
			}
			if (!response.ok) {
				throw providerError(
					`Jenkins request failed with HTTP ${response.status}`,
				);
			}
			const declaredLength = Number(response.headers.get("content-length"));
			if (declaredLength > maxResponseBytes) {
				throw providerError("Jenkins response is too large");
			}
			const text = await response.text();
			if (Buffer.byteLength(text) > maxResponseBytes) {
				throw providerError("Jenkins response is too large");
			}
			try {
				return JSON.parse(text) as JsonObject;
			} catch {
				throw providerError("Jenkins returned an invalid JSON response");
			}
		} catch (error) {
			if (error instanceof Error && error.name === "AbortError") {
				throw providerError("Jenkins request timed out");
			}
			throw error;
		} finally {
			clearTimeout(timeout);
		}
	}
}

type JenkinsCredential = { apiToken: string; username: string };

function parseCredential(encoded: string): JenkinsCredential {
	try {
		const value = JSON.parse(encoded) as Record<string, unknown>;
		const username =
			typeof value.username === "string" ? value.username.trim() : "";
		const apiToken = typeof value.apiToken === "string" ? value.apiToken : "";
		if (username && apiToken) return { apiToken, username };
	} catch {}
	throw invalidCredential("Jenkins username and API Token are required");
}

function jobPath(input: JsonObject) {
	const fullName = stringValue(input, "jobFullName");
	const segments = fullName?.split("/");
	if (
		!segments?.length ||
		segments.some((segment) => !segment || segment === "." || segment === "..")
	) {
		throw providerError("Jenkins jobFullName is invalid");
	}
	return segments
		.map((segment) => `/job/${encodeURIComponent(segment)}`)
		.join("");
}

function positiveInteger(input: JsonObject, name: string) {
	const value = input[name];
	if (!Number.isSafeInteger(value) || Number(value) < 1) {
		throw providerError(`Jenkins ${name} must be a positive integer`);
	}
	return Number(value);
}

function stringValue(input: JsonObject, name: string) {
	const value = input[name];
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function providerError(message: string) {
	return new Error(message);
}

function invalidCredential(message: string) {
	return Object.assign(new Error(message), { providerCredentialInvalid: true });
}
