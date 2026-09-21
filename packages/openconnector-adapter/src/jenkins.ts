import type {
	CredentialForExecution,
	ProviderCredentialConnector,
	ProviderExecutor,
} from "@agent-infra/connection-core";

import { jenkinsExecutorDigest } from "./jenkins-integrity.ts";

const credentialScope = "jenkins.read";
const maxArtifactBytes = 256 * 1024;
const maxConsoleBytes = 256 * 1024;
const maxResponseBytes = 5 * 1024 * 1024;
const requestTimeoutMs = 30_000;
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
		description:
			"按字节游标读取 Jenkins Build console log，内容不脱敏，单次最多返回 256 KiB。",
		name: "get_build_console",
		properties: {
			buildNumber: { minimum: 1, type: "integer" },
			jobFullName: { minLength: 1, type: "string" },
			start: { minimum: 0, type: "integer" },
		},
		required: ["jobFullName", "buildNumber", "start"],
	},
	{
		description:
			"按字节游标读取 Jenkins Build artifact，单次最多返回 256 KiB；完整文本同时返回 text，分页或二进制内容返回 Base64。",
		name: "get_build_artifact",
		properties: {
			artifactPath: { minLength: 1, type: "string" },
			buildNumber: { minimum: 1, type: "integer" },
			jobFullName: { minLength: 1, type: "string" },
			start: { minimum: 0, type: "integer" },
		},
		required: ["jobFullName", "buildNumber", "artifactPath", "start"],
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
			id: `${profile.providerId}.${action.name}@v4`,
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
		providerReleaseId: `${profile.providerId}-connection-v4`,
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
			case "get_build_console":
				return this.requestConsole(
					credential,
					`${jobPath(input.input)}/${positiveInteger(input.input, "buildNumber")}/logText/progressiveText?start=${nonNegativeInteger(input.input, "start")}`,
					nonNegativeInteger(input.input, "start"),
				);
			case "get_build_artifact": {
				const start = artifactStart(input.input);
				return this.requestArtifact(
					credential,
					`${jobPath(input.input)}/${positiveInteger(input.input, "buildNumber")}/artifact/${artifactPath(input.input)}`,
					start,
				);
			}
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
		const response = await this.fetchRead(
			new URL(path, this.profile.apiOrigin),
			{
				headers: {
					accept: "application/json",
					authorization: `Basic ${Buffer.from(`${credential.username}:${credential.apiToken}`).toString("base64")}`,
				},
				redirect: "manual",
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
				{ providerStatus: response.status },
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
	}

	private async requestConsole(
		credential: JenkinsCredential,
		path: string,
		start: number,
	) {
		const response = await this.fetchRead(
			new URL(path, this.profile.apiOrigin),
			{
				headers: {
					accept: "text/plain",
					authorization: `Basic ${Buffer.from(`${credential.username}:${credential.apiToken}`).toString("base64")}`,
				},
				redirect: "manual",
			},
		);
		if (response.status === 401 || response.status === 403) {
			throw invalidCredential("Jenkins credential was rejected");
		}
		if (response.status >= 300 && response.status < 400) {
			throw providerError("Jenkins request redirected");
		}
		if (!response.ok) {
			throw providerError(
				`Jenkins request failed with HTTP ${response.status}`,
				{ providerStatus: response.status },
			);
		}
		const { bytes: returned, truncated } = await readLimitedBytes(
			response,
			maxConsoleBytes,
		);
		const reportedNext = Number(response.headers.get("x-text-size"));
		return {
			moreData:
				truncated ||
				response.headers.get("x-more-data")?.toLowerCase() === "true",
			nextStart:
				!truncated &&
				Number.isSafeInteger(reportedNext) &&
				reportedNext >= start
					? reportedNext
					: start + returned.byteLength,
			text: new TextDecoder().decode(returned),
			truncated,
		};
	}

	private async requestArtifact(
		credential: JenkinsCredential,
		path: string,
		start: number,
	) {
		const response = await this.fetchRead(
			new URL(path, this.profile.apiOrigin),
			{
				headers: {
					accept: "*/*",
					"accept-encoding": "identity",
					authorization: `Basic ${Buffer.from(`${credential.username}:${credential.apiToken}`).toString("base64")}`,
					range: `bytes=${start}-${start + maxArtifactBytes - 1}`,
				},
				redirect: "manual",
			},
		);
		if (response.status === 401 || response.status === 403) {
			throw invalidCredential("Jenkins credential was rejected");
		}
		if (response.status >= 300 && response.status < 400) {
			throw providerError("Jenkins request redirected");
		}
		if (!response.ok) {
			throw providerError(
				`Jenkins request failed with HTTP ${response.status}`,
				{ providerStatus: response.status },
			);
		}
		const contentEncoding = response.headers
			.get("content-encoding")
			?.toLowerCase();
		if (contentEncoding && contentEncoding !== "identity") {
			throw providerError(
				"Jenkins returned an encoded artifact representation",
			);
		}
		if (start > 0 && response.status !== 206) {
			throw providerError("Jenkins artifact does not support ranged reads");
		}
		const { bytes, truncated } = await readLimitedBytes(
			response,
			maxArtifactBytes,
		);
		const contentRange = parseContentRange(
			response.headers.get("content-range"),
		);
		if (
			response.status === 206 &&
			(!contentRange ||
				contentRange.start !== start ||
				contentRange.end - contentRange.start + 1 !== bytes.byteLength)
		) {
			throw providerError("Jenkins returned an invalid artifact byte range");
		}
		const contentLengthValue = response.headers.get("content-length");
		const contentLength =
			contentLengthValue === null ? undefined : Number(contentLengthValue);
		const size =
			contentRange?.size ??
			(response.status === 200 &&
			Number.isSafeInteger(contentLength) &&
			Number(contentLength) >= bytes.byteLength
				? Number(contentLength)
				: undefined);
		const nextStart = contentRange
			? contentRange.end + 1
			: start + bytes.byteLength;
		const mimeType =
			response.headers.get("content-type")?.split(";", 1)[0]?.trim() ||
			"application/octet-stream";
		const moreData =
			truncated ||
			(size !== undefined && nextStart < size) ||
			(response.status === 206 && size === undefined);
		return {
			contentBase64: Buffer.from(bytes).toString("base64"),
			...(start === 0 && !moreData && isTextMimeType(mimeType)
				? { text: new TextDecoder().decode(bytes) }
				: {}),
			mimeType,
			moreData,
			nextStart,
			size,
			truncated,
		};
	}

	private async fetchRead(input: URL, init: RequestInit) {
		for (let attempt = 0; attempt < 2; attempt += 1) {
			const controller = new AbortController();
			const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
			try {
				return await this.fetcher(input, {
					...init,
					signal: controller.signal,
				});
			} catch (error) {
				const transportFailure =
					error instanceof Error &&
					(error.name === "AbortError" || error.name === "TypeError");
				if (transportFailure && attempt === 0) continue;
				if (transportFailure) {
					throw providerError("Jenkins request transport failed", {
						providerUnavailable: true,
					});
				}
				throw error;
			} finally {
				clearTimeout(timeout);
			}
		}
		throw providerError("Jenkins request transport failed", {
			providerUnavailable: true,
		});
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

function artifactPath(input: JsonObject) {
	const path = stringValue(input, "artifactPath");
	const segments = path?.split("/");
	if (
		!segments?.length ||
		segments.some((segment) => !segment || segment === "." || segment === "..")
	) {
		throw providerError("Jenkins artifactPath is invalid");
	}
	return segments.map(encodeURIComponent).join("/");
}

function artifactStart(input: JsonObject) {
	const start = nonNegativeInteger(input, "start");
	if (start > Number.MAX_SAFE_INTEGER - maxArtifactBytes) {
		throw providerError("Jenkins artifact start is too large");
	}
	return start;
}

function positiveInteger(input: JsonObject, name: string) {
	const value = input[name];
	if (!Number.isSafeInteger(value) || Number(value) < 1) {
		throw providerError(`Jenkins ${name} must be a positive integer`);
	}
	return Number(value);
}

function nonNegativeInteger(input: JsonObject, name: string) {
	const value = input[name];
	if (!Number.isSafeInteger(value) || Number(value) < 0) {
		throw providerError(`Jenkins ${name} must be a non-negative integer`);
	}
	return Number(value);
}

async function readLimitedBytes(response: Response, limit: number) {
	if (!response.body) return { bytes: new Uint8Array(), truncated: false };
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	let truncated = false;
	while (size <= limit) {
		const { done, value } = await reader.read();
		if (done) break;
		const remaining = limit - size;
		if (value.byteLength > remaining) {
			chunks.push(value.subarray(0, remaining));
			size += remaining;
			truncated = true;
			await reader.cancel();
			break;
		}
		chunks.push(value);
		size += value.byteLength;
	}
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return { bytes, truncated };
}

function parseContentRange(value: string | null) {
	const match = value?.match(/^bytes (\d+)-(\d+)\/(\d+|\*)$/i);
	if (!match) return undefined;
	const start = Number(match[1]);
	const end = Number(match[2]);
	const size = match[3] === "*" ? undefined : Number(match[3]);
	if (
		!Number.isSafeInteger(start) ||
		!Number.isSafeInteger(end) ||
		end < start ||
		(size !== undefined && (!Number.isSafeInteger(size) || end >= size))
	) {
		return undefined;
	}
	return { end, size, start };
}

function isTextMimeType(value: string) {
	const normalized = value.toLowerCase();
	return (
		normalized.startsWith("text/") ||
		normalized === "application/json" ||
		normalized === "application/xml" ||
		normalized.endsWith("+json") ||
		normalized.endsWith("+xml")
	);
}

function stringValue(input: JsonObject, name: string) {
	const value = input[name];
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function providerError(
	message: string,
	metadata: { providerStatus?: number; providerUnavailable?: boolean } = {},
) {
	return Object.assign(new Error(message), metadata);
}

function invalidCredential(message: string) {
	return Object.assign(new Error(message), { providerCredentialInvalid: true });
}
