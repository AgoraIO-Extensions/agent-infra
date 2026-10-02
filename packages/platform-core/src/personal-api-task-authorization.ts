import { types } from "node:util";
import {
	requireAgentManagementExactKeys as exact,
	snapshotAgentManagementDataObject,
	isAgentManagementText as text,
} from "./agent-management-input.js";
import {
	PersonalApiCredentialErrorV1,
	parsePersonalApiCredentialScopesV1,
} from "./personal-api-credentials.js";
import {
	type CurrentTaskApplicationV1,
	type CurrentTaskUserV1,
	isTaskApiChannelV1,
	parseCurrentTaskApplicationV1,
	parseCurrentTaskUserV1,
	parseTaskPrincipalV1,
	type TaskApiChannelV1,
	type TaskPrincipalV1,
} from "./task-authorization.js";

/** Server-resolved, transient request authority. Never serialize into a Task. */
export interface PersonalApiTaskAdmissionAuthorityV1 {
	readonly schemaVersion: 1;
	readonly principal: TaskPrincipalV1;
	readonly credentialId: string;
	readonly credentialHash: string;
	readonly agentId: string;
	readonly channelId: TaskApiChannelV1;
	readonly operation: "agent:use" | "agent:read";
	readonly identityRevision: string;
	readonly useGrantRevision: string;
}

export interface PersonalApiTaskBindingV1 {
	readonly principal: TaskPrincipalV1;
	readonly actorId: string;
	readonly agentId: string;
	readonly channelId: TaskApiChannelV1;
	readonly operation?: "agent:use" | "agent:read";
}

/** Facts for the API boundary owner; this is not a Web TaskAuthorizationBoundary. */
export interface PersonalApiTaskUseAuthorizationV1 {
	readonly principal: TaskPrincipalV1;
	readonly agentId: string;
	readonly channelId: TaskApiChannelV1;
	readonly identityRevision: string;
	readonly useGrantRevision: string;
}

function object(input: unknown): Record<string, unknown> {
	// The shared snapshot copies into {}; an own __proto__ data property must not
	// disappear through that object's inherited setter before exact-key validation.
	if (
		input !== null &&
		typeof input === "object" &&
		!types.isProxy(input) &&
		Object.hasOwn(input, "__proto__")
	) {
		throw new Error();
	}
	return snapshotAgentManagementDataObject(input);
}

export function parsePersonalApiTaskAdmissionAuthorityV1(
	input: unknown,
): PersonalApiTaskAdmissionAuthorityV1 {
	try {
		const value = object(input);
		exact(value, [
			"schemaVersion",
			"principal",
			"credentialId",
			"credentialHash",
			"agentId",
			"channelId",
			"operation",
			"identityRevision",
			"useGrantRevision",
		]);
		const principal = parseTaskPrincipalV1(value.principal);
		if (
			value.schemaVersion !== 1 ||
			!text(value.credentialId) ||
			typeof value.credentialHash !== "string" ||
			!/^[a-f0-9]{64}$/.test(value.credentialHash) ||
			!text(value.agentId) ||
			typeof value.channelId !== "string" ||
			!isTaskApiChannelV1(value.channelId, principal) ||
			(value.operation !== "agent:use" && value.operation !== "agent:read") ||
			!text(value.identityRevision) ||
			!text(value.useGrantRevision)
		) {
			throw new Error();
		}
		return Object.freeze({
			schemaVersion: 1,
			principal: Object.freeze(principal),
			credentialId: value.credentialId,
			credentialHash: value.credentialHash,
			agentId: value.agentId,
			channelId: value.channelId as TaskApiChannelV1,
			operation: value.operation,
			identityRevision: value.identityRevision,
			useGrantRevision: value.useGrantRevision,
		});
	} catch {
		throw new PersonalApiCredentialErrorV1("invalid_input");
	}
}

/** Called before any database/advisory/Conversation locks. */
export function requirePersonalApiTaskBindingV1(
	authority: PersonalApiTaskAdmissionAuthorityV1,
	input: unknown,
): void {
	try {
		const binding = object(input);
		exact(binding, [
			"principal",
			"actorId",
			"agentId",
			"channelId",
			...(Object.hasOwn(binding, "operation") ? ["operation"] : []),
		]);
		const principal = object(binding.principal);
		exact(principal, ["kind", "id"]);
		if (
			principal.kind !== authority.principal.kind ||
			principal.id !== authority.principal.id ||
			binding.actorId !== authority.principal.id ||
			binding.agentId !== authority.agentId ||
			binding.channelId !== authority.channelId ||
			(Object.hasOwn(binding, "operation") &&
				binding.operation !== authority.operation)
		) {
			throw new Error();
		}
	} catch {
		throw new PersonalApiCredentialErrorV1("forbidden");
	}
}

/** Decide only from current facts obtained inside the caller's transaction. */
export function requirePersonalApiTaskUseAuthorizationV1(input: {
	readonly authority: PersonalApiTaskAdmissionAuthorityV1;
	readonly credential: {
		readonly id: string;
		readonly credentialHash: string;
		readonly principalType: string;
		readonly principalId: string;
		readonly scopes: unknown;
		readonly expiresAt: Date | null;
		readonly revokedAt: Date | null;
	} | null;
	readonly user: CurrentTaskUserV1 | null;
	readonly application?: CurrentTaskApplicationV1 | null;
	readonly disabled: boolean;
	readonly grant: {
		readonly agentId: string;
		readonly principalType: string;
		readonly principalId: string;
		readonly grantType: string;
		readonly authorizationRevision: string;
		readonly revokedAt: Date | null;
	} | null;
	readonly now: Date;
}): PersonalApiTaskUseAuthorizationV1 {
	try {
		const authority = parsePersonalApiTaskAdmissionAuthorityV1(input.authority);
		const credential = input.credential;
		const validDate = (value: unknown): value is Date =>
			value instanceof Date && Number.isFinite(value.getTime());
		if (!validDate(input.now)) {
			throw new PersonalApiCredentialErrorV1("unavailable");
		}
		if (
			!credential ||
			credential.id !== authority.credentialId ||
			credential.credentialHash !== authority.credentialHash ||
			credential.principalType !== authority.principal.kind ||
			credential.principalId !== authority.principal.id
		) {
			throw new PersonalApiCredentialErrorV1("authentication_required");
		}
		if (
			(credential.expiresAt !== null && !validDate(credential.expiresAt)) ||
			(credential.revokedAt !== null && !validDate(credential.revokedAt))
		) {
			throw new PersonalApiCredentialErrorV1("unavailable");
		}
		if (
			credential.revokedAt !== null ||
			(credential.expiresAt !== null &&
				credential.expiresAt.getTime() <= input.now.getTime())
		) {
			throw new PersonalApiCredentialErrorV1("authentication_required");
		}
		let scopes: ReturnType<typeof parsePersonalApiCredentialScopesV1>;
		try {
			scopes = parsePersonalApiCredentialScopesV1(credential.scopes);
		} catch {
			throw new PersonalApiCredentialErrorV1("unavailable");
		}
		if (!scopes.includes(authority.operation)) {
			throw new PersonalApiCredentialErrorV1("forbidden");
		}
		let identityRevision: string;
		if (authority.principal.kind === "application") {
			if (!input.application)
				throw new PersonalApiCredentialErrorV1("forbidden");
			const application = parseCurrentTaskApplicationV1(input.application);
			if (application.applicationId !== authority.principal.id)
				throw new PersonalApiCredentialErrorV1("unavailable");
			if (application.status !== "active")
				throw new PersonalApiCredentialErrorV1("forbidden");
			identityRevision = application.authorizationRevision;
		} else {
			const user = parseCurrentTaskUserV1(input.user);
			if (user.userId !== authority.principal.id)
				throw new PersonalApiCredentialErrorV1("unavailable");
			if (input.disabled || user.accountStatus !== "active")
				throw new PersonalApiCredentialErrorV1("forbidden");
			identityRevision = user.authorizationRevision;
		}
		if (identityRevision !== authority.identityRevision)
			throw new PersonalApiCredentialErrorV1("unavailable");

		if (
			!input.grant ||
			input.grant.agentId !== authority.agentId ||
			input.grant.principalType !== authority.principal.kind ||
			input.grant.principalId !== authority.principal.id ||
			input.grant.grantType !== "use" ||
			input.grant.revokedAt !== null
		) {
			throw new PersonalApiCredentialErrorV1("not_found");
		}
		if (
			!text(input.grant.authorizationRevision) ||
			input.grant.authorizationRevision !== authority.useGrantRevision
		) {
			throw new PersonalApiCredentialErrorV1("unavailable");
		}
		return Object.freeze({
			principal: authority.principal,
			agentId: authority.agentId,
			channelId: authority.channelId,
			identityRevision,
			useGrantRevision: input.grant.authorizationRevision,
		});
	} catch (error) {
		if (error instanceof PersonalApiCredentialErrorV1) throw error;
		throw new PersonalApiCredentialErrorV1("unavailable");
	}
}
