import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

export type ApiPrincipalV1 =
	| { readonly kind: "user"; readonly id: string }
	| { readonly kind: "application"; readonly id: string };

export const apiCredentialScopesV1 = [
	"agent:create",
	"agent:manage",
	"agent:use",
	"agent:read",
] as const;

export type ApiCredentialScopeV1 = (typeof apiCredentialScopesV1)[number];

export interface CurrentApiPrincipalV1 {
	readonly schemaVersion: 1;
	readonly principal: ApiPrincipalV1;
	readonly accountStatus: "active" | "disabled";
	readonly organizationIds: readonly string[];
	readonly authorizationRevision: string;
}

export interface ApiCredentialMetadataV1 {
	readonly schemaVersion: 1;
	readonly credentialId: string;
	readonly principal: ApiPrincipalV1;
	readonly scopes: readonly ApiCredentialScopeV1[];
	readonly expiresAt: Date | null;
	readonly revokedAt: Date | null;
	readonly createdAt: Date;
}

export type ApiIdentityAuditActionV1 =
	| "api.application.created"
	| "api.credential.issued"
	| "api.credential.revoked"
	| "api.credential.delivery.granted"
	| "api.credential.delivery.revoked"
	| "api.agent.grant.granted"
	| "api.agent.grant.revoked";

export interface ApiIdentityAuditInputV1 {
	readonly traceId: string;
	readonly requestId: string;
	readonly actor: ApiPrincipalV1;
	readonly action: ApiIdentityAuditActionV1;
	readonly recipient?: ApiPrincipalV1;
	readonly grantType?: "manage" | "use";
	readonly outcome?: "succeeded" | "rejected" | "failed";
}

function validText(value: unknown, maxBytes = 1024): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		!value.includes("\0") &&
		String.prototype.isWellFormed.call(value) &&
		Buffer.byteLength(value, "utf8") <= maxBytes
	);
}

export function hashApiCredentialV1(credential: string): string {
	if (!validText(credential, 4096))
		throw new TypeError("Credential is invalid");
	return createHash("sha256")
		.update("agent-infra-api-credential:v1\0", "utf8")
		.update(credential, "utf8")
		.digest("hex");
}

export function generateApiCredentialV1(
	randomBytes: (size: number) => Uint8Array,
): string {
	const bytes = randomBytes(32);
	if (!(bytes instanceof Uint8Array) || bytes.byteLength !== 32) {
		throw new TypeError("Credential entropy is invalid");
	}
	return Buffer.from(bytes).toString("base64url");
}

export function isApiCredentialScopeV1(
	value: unknown,
): value is ApiCredentialScopeV1 {
	return apiCredentialScopesV1.includes(value as ApiCredentialScopeV1);
}

export function hasApiCredentialScopeV1(
	metadata: Pick<ApiCredentialMetadataV1, "scopes" | "expiresAt" | "revokedAt">,
	scope: ApiCredentialScopeV1,
	now = new Date(),
): boolean {
	return (
		metadata.revokedAt === null &&
		(metadata.expiresAt === null ||
			metadata.expiresAt.getTime() > now.getTime()) &&
		metadata.scopes.includes(scope)
	);
}

export function sameApiPrincipalV1(
	left: ApiPrincipalV1,
	right: ApiPrincipalV1,
): boolean {
	return left.kind === right.kind && left.id === right.id;
}
