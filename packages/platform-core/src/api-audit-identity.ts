import {
	isAgentManagementText,
	requireAgentManagementExactKeys,
	snapshotAgentManagementDataObject,
} from "./agent-management-input.js";
import type { ApiCredentialMetadataV1, ApiPrincipalV1 } from "./audit-query.js";
import {
	PersonalApiCredentialErrorV1,
	type PersonalApiCredentialScopeV1,
	parsePersonalApiCredentialScopesV1,
	personalApiCredentialScopesV1,
} from "./personal-api-credentials.js";
import {
	type CurrentTaskUserV1,
	parseCurrentTaskUserV1,
} from "./task-authorization.js";

/** Transient query identity. It grants neither Agent access nor Task admission. */
export interface ApiAuditCredentialIdentityV1 {
	readonly principal: ApiPrincipalV1;
	readonly credential: ApiCredentialMetadataV1;
	readonly identityRevision: string;
	readonly user?: CurrentTaskUserV1;
}

function date(input: unknown): Date {
	const time = Date.prototype.getTime.call(input);
	if (!Number.isFinite(time)) throw new TypeError();
	return new Date(time);
}

/** Authenticate a current subject and credential scope; consumers still enforce object grants. */
export function requireApiCredentialIdentityV1(
	input: {
		readonly credential: unknown;
		readonly user?: unknown;
		readonly application?: unknown;
		readonly disabled: boolean;
		readonly now: Date;
	},
	requiredScope: PersonalApiCredentialScopeV1,
): ApiAuditCredentialIdentityV1 {
	try {
		if (
			!personalApiCredentialScopesV1.includes(requiredScope) ||
			typeof input.disabled !== "boolean"
		)
			throw new TypeError();
		const value = snapshotAgentManagementDataObject(input.credential);
		requireAgentManagementExactKeys(value, [
			"schemaVersion",
			"credentialId",
			"principal",
			"scopes",
			"expiresAt",
			"revokedAt",
			"createdAt",
		]);
		const subject = snapshotAgentManagementDataObject(value.principal);
		requireAgentManagementExactKeys(subject, ["kind", "id"]);
		if (
			value.schemaVersion !== 1 ||
			!isAgentManagementText(value.credentialId) ||
			!isAgentManagementText(subject.id) ||
			(subject.kind !== "user" && subject.kind !== "application")
		)
			throw new TypeError();
		const principal: ApiPrincipalV1 = Object.freeze({
			kind: subject.kind,
			id: subject.id,
		});
		const credential: ApiCredentialMetadataV1 = Object.freeze({
			schemaVersion: 1,
			credentialId: value.credentialId,
			principal,
			scopes: parsePersonalApiCredentialScopesV1(value.scopes),
			expiresAt: value.expiresAt === null ? null : date(value.expiresAt),
			revokedAt: value.revokedAt === null ? null : date(value.revokedAt),
			createdAt: date(value.createdAt),
		});
		const now = date(input.now);
		if (
			credential.revokedAt !== null ||
			(credential.expiresAt !== null && credential.expiresAt <= now)
		)
			throw new PersonalApiCredentialErrorV1("authentication_required");
		if (!credential.scopes.includes(requiredScope))
			throw new PersonalApiCredentialErrorV1("forbidden");
		if (principal.kind === "user") {
			if (input.application !== undefined) throw new TypeError();
			const user = parseCurrentTaskUserV1(input.user);
			if (user.userId !== principal.id) throw new TypeError();
			if (input.disabled || user.accountStatus !== "active")
				throw new PersonalApiCredentialErrorV1("forbidden");
			return Object.freeze({
				principal,
				credential,
				user,
				identityRevision: user.authorizationRevision,
			});
		}
		if (input.user !== undefined || input.disabled) throw new TypeError();
		const application = snapshotAgentManagementDataObject(input.application);
		requireAgentManagementExactKeys(application, [
			"applicationId",
			"status",
			"authorizationRevision",
		]);
		if (
			application.applicationId !== principal.id ||
			!isAgentManagementText(application.authorizationRevision) ||
			(application.status !== "active" && application.status !== "disabled")
		)
			throw new TypeError();
		if (application.status !== "active")
			throw new PersonalApiCredentialErrorV1("forbidden");
		return Object.freeze({
			principal,
			credential,
			identityRevision: application.authorizationRevision,
		});
	} catch (error) {
		if (
			error instanceof PersonalApiCredentialErrorV1 &&
			error.code !== "invalid_input"
		)
			throw error;
		throw new PersonalApiCredentialErrorV1("unavailable");
	}
}

/** Audit queries retain their existing agent:use requirement. */
export function requireApiAuditCredentialIdentityV1(
	input: Parameters<typeof requireApiCredentialIdentityV1>[0],
): ApiAuditCredentialIdentityV1 {
	return requireApiCredentialIdentityV1(input, "agent:use");
}
