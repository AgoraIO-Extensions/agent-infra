import {
	type ApiCredentialMetadataV1,
	type ApiCredentialScopeV1,
	type ApiIdentityAuditInputV1,
	type ApiPrincipalV1,
	hasApiCredentialScopeV1,
	sameApiPrincipalV1,
} from "./api-identity.js";

export interface ApiIdentityApplicationV1 {
	readonly id: string;
	readonly name: string;
	readonly responsibleUserId: string;
	readonly status: "active" | "disabled";
	readonly authorizationRevision: string;
}

export interface ApiIdentityActorV1 {
	readonly schemaVersion: 1;
	readonly userId: string;
	readonly accountStatus?: "active" | "disabled";
	readonly principal?: ApiPrincipalV1;
	readonly isAdministrator: boolean;
	/** Present when this actor was authenticated with an API credential. */
	readonly credential?: Pick<
		ApiCredentialMetadataV1,
		"scopes" | "expiresAt" | "revokedAt"
	>;
}

export interface ApiIdentityCredentialIssueInputV1 {
	readonly principal: ApiPrincipalV1;
	readonly credential: string;
	readonly scopes: readonly ApiCredentialScopeV1[];
	readonly expiresAt: Date | null;
	readonly recipient?: ApiPrincipalV1;
	readonly audit: ApiIdentityAuditInputV1;
}

export interface ApiIdentityCredentialIssueResultV1 {
	readonly credentialId: string;
	readonly metadata: ApiCredentialMetadataV1;
}

export interface ApiIdentityStorePortV1 {
	readonly writeAudit?: (
		input: ApiIdentityAuditInputV1 & { readonly targetId: string },
	) => Promise<void>;
	createApplication(input: {
		readonly applicationId: string;
		readonly name: string;
		readonly responsibleUserId: string;
		readonly authorizationRevision: string;
		readonly audit: ApiIdentityAuditInputV1;
	}): Promise<void>;
	getApplication(
		applicationId: string,
	): Promise<ApiIdentityApplicationV1 | null>;
	listApplications(
		responsibleUserId: string,
	): Promise<readonly ApiIdentityApplicationV1[]>;
	issueCredential(
		input: ApiIdentityCredentialIssueInputV1,
	): Promise<ApiIdentityCredentialIssueResultV1>;
	listCredentials(input: {
		readonly principal?: ApiPrincipalV1;
		readonly applicationId?: string;
	}): Promise<readonly ApiCredentialMetadataV1[]>;
	getCredentialMetadata(
		credentialId: string,
	): Promise<ApiCredentialMetadataV1 | null>;
	grantCredentialDelivery(input: {
		readonly applicationId: string;
		readonly principal: ApiPrincipalV1;
		readonly authorizationRevision: string;
		readonly audit: ApiIdentityAuditInputV1;
	}): Promise<void>;
	/**
	 * Re-checks the currently active delivery grant immediately before a
	 * credential value is persisted. Implementations must apply the same
	 * application revision and active-status rules as issueCredential.
	 */
	hasCredentialDelivery(input: {
		readonly applicationId: string;
		readonly principal: ApiPrincipalV1;
	}): Promise<boolean>;
	revokeCredentialDelivery(input: {
		readonly applicationId: string;
		readonly principal: ApiPrincipalV1;
		readonly revokedAt?: Date;
		readonly audit: ApiIdentityAuditInputV1;
	}): Promise<boolean>;
	revokeCredential(
		credentialId: string,
		revokedAt: Date,
		audit: ApiIdentityAuditInputV1,
	): Promise<boolean>;
	grantAgent(input: {
		readonly agentId: string;
		readonly principal: ApiPrincipalV1;
		readonly grantType: "manage" | "use";
		readonly authorizationRevision: string;
		readonly audit: ApiIdentityAuditInputV1;
	}): Promise<void>;
	revokeAgentGrant(input: {
		readonly agentId: string;
		readonly principal: ApiPrincipalV1;
		readonly grantType: "manage" | "use";
		readonly revokedAt?: Date;
		readonly audit: ApiIdentityAuditInputV1;
	}): Promise<boolean>;
}

export interface ApiIdentityDirectoryPortV1 {
	resolveUser(userId: string): Promise<{
		readonly userId: string;
		readonly accountStatus: "active" | "disabled";
	} | null>;
}

export interface ApiIdentityAgentAccessPortV1 {
	canManage(input: {
		readonly actor: ApiIdentityActorV1;
		readonly agentId: string;
	}): Promise<boolean>;
}

export interface ApiIdentityManagementInterfaceV1 {
	readonly [key: string]: unknown;
	authorizeCredentialScope(
		actor: ApiIdentityActorV1,
		required: readonly ApiCredentialScopeV1[],
	): void;
	resolveAgentQueryGrantType(
		actor: ApiIdentityActorV1,
	): "any" | "manage" | "use";
	listUserCredentials(
		actor: ApiIdentityActorV1,
	): Promise<readonly ApiCredentialMetadataV1[]>;
	issueUserCredential(
		actor: ApiIdentityActorV1,
		input: Omit<ApiIdentityCredentialIssueInputV1, "principal" | "recipient">,
	): Promise<ApiIdentityCredentialIssueResultV1>;
	revokeUserCredential(
		actor: ApiIdentityActorV1,
		credentialId: string,
		revokedAt: Date,
		audit: ApiIdentityAuditInputV1,
	): Promise<void>;
	listApplications(
		actor: ApiIdentityActorV1,
	): Promise<readonly ApiIdentityApplicationV1[]>;
	createApplication(input: {
		readonly actor: ApiIdentityActorV1;
		readonly applicationId: string;
		readonly name: string;
		readonly authorizationRevision: string;
		readonly audit: ApiIdentityAuditInputV1;
	}): Promise<ApiIdentityApplicationV1>;
	listApplicationCredentials(
		actor: ApiIdentityActorV1,
		applicationId: string,
	): Promise<readonly ApiCredentialMetadataV1[]>;
	issueApplicationCredential(
		actor: ApiIdentityActorV1,
		applicationId: string,
		input: Omit<ApiIdentityCredentialIssueInputV1, "principal">,
	): Promise<ApiIdentityCredentialIssueResultV1>;
	revokeApplicationCredential(
		actor: ApiIdentityActorV1,
		applicationId: string,
		credentialId: string,
		revokedAt: Date,
		audit: ApiIdentityAuditInputV1,
	): Promise<void>;
	grantCredentialDelivery(input: {
		readonly actor: ApiIdentityActorV1;
		readonly applicationId: string;
		readonly principal: ApiPrincipalV1;
		readonly audit: ApiIdentityAuditInputV1;
	}): Promise<void>;
	revokeCredentialDelivery(input: {
		readonly actor: ApiIdentityActorV1;
		readonly applicationId: string;
		readonly principal: ApiPrincipalV1;
		readonly audit: ApiIdentityAuditInputV1;
	}): Promise<void>;
	grantAgent(input: {
		readonly actor: ApiIdentityActorV1;
		readonly agentId: string;
		readonly principal: ApiPrincipalV1;
		readonly grantType: "manage" | "use";
		readonly audit: ApiIdentityAuditInputV1;
	}): Promise<string>;
	revokeAgentGrant(input: {
		readonly actor: ApiIdentityActorV1;
		readonly agentId: string;
		readonly principal: ApiPrincipalV1;
		readonly grantType: "manage" | "use";
		readonly audit: ApiIdentityAuditInputV1;
	}): Promise<void>;
}

export type ApiIdentityErrorCode =
	| "not_authorized"
	| "resource_unavailable"
	| "dependency_unavailable";

const apiIdentityErrorBrand = Symbol.for(
	"@agent-infra/platform-core/ApiIdentityErrorV1",
);

export class ApiIdentityError extends Error {
	readonly code: ApiIdentityErrorCode;
	readonly [apiIdentityErrorBrand] = true;

	constructor(code: ApiIdentityErrorCode) {
		super(code);
		this.name = "ApiIdentityError";
		this.code = code;
	}
}

function actorPrincipal(actor: ApiIdentityActorV1): ApiPrincipalV1 {
	const principal = actor.principal ?? {
		kind: "user" as const,
		id: actor.userId,
	};
	if (principal.kind === "user" && principal.id !== actor.userId) {
		throw new ApiIdentityError("not_authorized");
	}
	return principal;
}

function checkedAudit(
	actor: ApiIdentityActorV1,
	audit: ApiIdentityAuditInputV1,
): ApiIdentityAuditInputV1 {
	const principal = actorPrincipal(actor);
	if (!sameApiPrincipalV1(principal, audit.actor)) {
		throw new ApiIdentityError("not_authorized");
	}
	return { ...audit, actor: principal };
}

export function createApiIdentityManagementV1(input: {
	readonly store: ApiIdentityStorePortV1;
	readonly directory: ApiIdentityDirectoryPortV1;
	readonly agentAccess: ApiIdentityAgentAccessPortV1;
	readonly idFactory: () => string;
}): ApiIdentityManagementInterfaceV1 {
	const requireActiveActor = (actor: ApiIdentityActorV1): ApiPrincipalV1 => {
		if (actor.accountStatus !== "active")
			throw new ApiIdentityError("not_authorized");
		return actorPrincipal(actor);
	};
	const requireCredentialScope = (
		actor: ApiIdentityActorV1,
		required: readonly ApiCredentialScopeV1[],
	): void => {
		requireActiveActor(actor);
		const credential = actor.credential;
		if (
			credential === undefined ||
			!required.some((scope) => hasApiCredentialScopeV1(credential, scope))
		) {
			throw new ApiIdentityError("not_authorized");
		}
	};
	const requireUserActor = (actor: ApiIdentityActorV1): string => {
		const principal = requireActiveActor(actor);
		if (principal.kind !== "user") throw new ApiIdentityError("not_authorized");
		return principal.id;
	};
	const applicationForActor = async (
		actor: ApiIdentityActorV1,
		applicationId: string,
	): Promise<ApiIdentityApplicationV1> => {
		const userId = requireUserActor(actor);
		const application = await input.store.getApplication(applicationId);
		if (!application || application.responsibleUserId !== userId)
			throw new ApiIdentityError("resource_unavailable");
		return application;
	};
	const requireActiveRecipient = async (
		principal: ApiPrincipalV1,
		audit?: ApiIdentityAuditInputV1,
	): Promise<void> => {
		if (principal.kind === "application") {
			const application = await input.store.getApplication(principal.id);
			if (application?.status !== "active") {
				if (audit && input.store.writeAudit)
					await input.store.writeAudit({
						...audit,
						recipient: principal,
						outcome: "rejected",
						targetId: principal.id,
					});
				throw new ApiIdentityError("resource_unavailable");
			}
			return;
		}
		const user = await input.directory.resolveUser(principal.id);
		if (
			!user ||
			user.userId !== principal.id ||
			user.accountStatus !== "active"
		) {
			if (audit && input.store.writeAudit)
				await input.store.writeAudit({
					...audit,
					recipient: principal,
					outcome: "rejected",
					targetId: principal.id,
				});
			throw new ApiIdentityError("resource_unavailable");
		}
	};
	const requireAgentAccess = async (
		actor: ApiIdentityActorV1,
		agentId: string,
	): Promise<void> => {
		requireActiveActor(actor);
		if (actor.principal !== undefined)
			requireCredentialScope(actor, ["agent:manage"]);
		if (!(await input.agentAccess.canManage({ actor, agentId })))
			throw new ApiIdentityError("resource_unavailable");
	};
	return {
		authorizeCredentialScope(actor, required) {
			requireCredentialScope(actor, required);
		},
		resolveAgentQueryGrantType(actor) {
			requireActiveActor(actor);
			const credential = actor.credential;
			if (credential === undefined)
				throw new ApiIdentityError("not_authorized");
			if (
				hasApiCredentialScopeV1(credential, "agent:manage") &&
				hasApiCredentialScopeV1(credential, "agent:use")
			)
				return "any";
			if (hasApiCredentialScopeV1(credential, "agent:manage")) return "manage";
			if (
				hasApiCredentialScopeV1(credential, "agent:use") ||
				hasApiCredentialScopeV1(credential, "agent:read")
			)
				return "use";
			throw new ApiIdentityError("not_authorized");
		},
		async listUserCredentials(actor) {
			const userId = requireUserActor(actor);
			return input.store.listCredentials({
				principal: { kind: "user", id: userId },
			});
		},
		async issueUserCredential(actor, value) {
			const userId = requireUserActor(actor);
			return input.store.issueCredential({
				...value,
				principal: { kind: "user", id: userId },
				audit: checkedAudit(actor, value.audit),
			});
		},
		async revokeUserCredential(actor, credentialId, revokedAt, audit) {
			const userId = requireUserActor(actor);
			const credential = await input.store.getCredentialMetadata(credentialId);
			if (
				credential?.principal.kind !== "user" ||
				credential?.principal.id !== userId
			)
				throw new ApiIdentityError("resource_unavailable");
			if (
				!(await input.store.revokeCredential(
					credentialId,
					revokedAt,
					checkedAudit(actor, audit),
				))
			)
				throw new ApiIdentityError("resource_unavailable");
		},
		async listApplications(actor) {
			return input.store.listApplications(requireUserActor(actor));
		},
		async createApplication(value) {
			const userId = requireUserActor(value.actor);
			await input.store.createApplication({
				applicationId: value.applicationId,
				name: value.name,
				responsibleUserId: userId,
				authorizationRevision: value.authorizationRevision,
				audit: checkedAudit(value.actor, value.audit),
			});
			const application = await input.store.getApplication(value.applicationId);
			if (!application) throw new ApiIdentityError("dependency_unavailable");
			return application;
		},
		async listApplicationCredentials(actor, applicationId) {
			await applicationForActor(actor, applicationId);
			return input.store.listCredentials({
				principal: { kind: "application", id: applicationId },
			});
		},
		async issueApplicationCredential(actor, applicationId, value) {
			const application = await applicationForActor(actor, applicationId);
			if (application.status !== "active")
				throw new ApiIdentityError("resource_unavailable");
			if (!value.recipient) throw new ApiIdentityError("not_authorized");
			const audit = checkedAudit(actor, value.audit);
			await requireActiveRecipient(value.recipient, audit);
			try {
				if (
					!(await input.store.hasCredentialDelivery({
						applicationId: application.id,
						principal: value.recipient,
					}))
				) {
					if (input.store.writeAudit)
						await input.store.writeAudit({
							...audit,
							recipient: value.recipient,
							outcome: "rejected",
							targetId: application.id,
						});
					throw new ApiIdentityError("resource_unavailable");
				}
				return await input.store.issueCredential({
					...value,
					principal: { kind: "application", id: application.id },
					audit,
				});
			} catch (error) {
				if (error instanceof ApiIdentityError) throw error;
				if (input.store.writeAudit)
					await input.store.writeAudit({
						...audit,
						outcome: "failed",
						targetId: application.id,
					});
				throw new ApiIdentityError("dependency_unavailable");
			}
		},
		async revokeApplicationCredential(
			actor,
			applicationId,
			credentialId,
			revokedAt,
			audit,
		) {
			const application = await applicationForActor(actor, applicationId);
			const credential = await input.store.getCredentialMetadata(credentialId);
			if (
				credential?.principal.kind !== "application" ||
				credential?.principal.id !== application.id
			)
				throw new ApiIdentityError("resource_unavailable");
			if (
				!(await input.store.revokeCredential(
					credentialId,
					revokedAt,
					checkedAudit(actor, audit),
				))
			)
				throw new ApiIdentityError("resource_unavailable");
		},
		async grantCredentialDelivery(value) {
			const application = await applicationForActor(
				value.actor,
				value.applicationId,
			);
			if (application.status !== "active")
				throw new ApiIdentityError("resource_unavailable");
			await requireActiveRecipient(
				value.principal,
				checkedAudit(value.actor, value.audit),
			);
			const audit = checkedAudit(value.actor, {
				...value.audit,
				recipient: value.principal,
			});
			try {
				await input.store.grantCredentialDelivery({
					applicationId: application.id,
					principal: value.principal,
					authorizationRevision: application.authorizationRevision,
					audit,
				});
			} catch {
				if (input.store.writeAudit)
					await input.store.writeAudit({
						...audit,
						outcome: "failed",
						targetId: application.id,
					});
				throw new ApiIdentityError("resource_unavailable");
			}
		},
		async revokeCredentialDelivery(value) {
			const application = await applicationForActor(
				value.actor,
				value.applicationId,
			);
			if (
				!(await input.store.revokeCredentialDelivery({
					applicationId: application.id,
					principal: value.principal,
					audit: checkedAudit(value.actor, {
						...value.audit,
						recipient: value.principal,
					}),
				}))
			)
				throw new ApiIdentityError("resource_unavailable");
		},
		async grantAgent(value) {
			await requireAgentAccess(value.actor, value.agentId);
			await requireActiveRecipient(
				value.principal,
				checkedAudit(value.actor, value.audit),
			);
			const authorizationRevision = input.idFactory();
			await input.store.grantAgent({
				agentId: value.agentId,
				principal: value.principal,
				grantType: value.grantType,
				authorizationRevision,
				audit: checkedAudit(value.actor, {
					...value.audit,
					recipient: value.principal,
					grantType: value.grantType,
				}),
			});
			return authorizationRevision;
		},
		async revokeAgentGrant(value) {
			await requireAgentAccess(value.actor, value.agentId);
			if (
				!(await input.store.revokeAgentGrant({
					agentId: value.agentId,
					principal: value.principal,
					grantType: value.grantType,
					audit: checkedAudit(value.actor, {
						...value.audit,
						recipient: value.principal,
						grantType: value.grantType,
					}),
				}))
			)
				throw new ApiIdentityError("resource_unavailable");
		},
	};
}
