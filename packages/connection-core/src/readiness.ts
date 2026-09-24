import { createHash } from "node:crypto";

export interface ConnectionContract {
	version: 1;
	paths: readonly string[];
	authority: "connection";
	selectorFields: readonly string[];
	redactions: readonly string[];
}

export const directMcpContract: ConnectionContract = Object.freeze({
	version: 1,
	paths: ["/v1/catalog", "/v1/mcp"],
	authority: "connection",
	selectorFields: [
		"principalId",
		"consumerId",
		"consumerInstanceId",
		"actorId",
		"connectionId",
		"grantId",
		"credentialVersionId",
	],
	redactions: [
		"ldapPassword",
		"browserCookie",
		"accessToken",
		"providerCredential",
	],
});

export function contractSha256(
	contract: ConnectionContract = directMcpContract,
): string {
	return createHash("sha256").update(JSON.stringify(contract)).digest("hex");
}

export interface ConnectionReadinessEvidence {
	repository: string;
	sourceCommit: string;
	imageDigests: Readonly<Record<string, string>>;
	migrationRevision: string;
	configRevision: string;
	contractSha256: string;
	environment: string;
	namespace: string;
	routes: readonly string[];
	redactedEvidenceArtifact: string;
}

export interface ConnectionReadinessResult {
	status: "Ready" | "No-Go";
	missing: readonly string[];
}

export function evaluateConnectionReadiness(
	evidence: Partial<ConnectionReadinessEvidence>,
): ConnectionReadinessResult {
	const missing: string[] = [];
	const required: readonly [keyof ConnectionReadinessEvidence, string][] = [
		["repository", "repository"],
		["sourceCommit", "exact source commit"],
		["imageDigests", "image digest"],
		["migrationRevision", "migration revision"],
		["configRevision", "configuration revision"],
		["contractSha256", "contract SHA"],
		["environment", "named environment"],
		["namespace", "namespace"],
		["routes", "runtime routes"],
		["redactedEvidenceArtifact", "redacted evidence artifact"],
	];
	for (const [key, label] of required) {
		const value = evidence[key];
		if (
			value === undefined ||
			(typeof value === "string" && value.trim() === "") ||
			(Array.isArray(value) && value.length === 0) ||
			(key === "imageDigests" && Object.keys(value as object).length === 0)
		)
			missing.push(label);
	}
	return { status: missing.length === 0 ? "Ready" : "No-Go", missing };
}
