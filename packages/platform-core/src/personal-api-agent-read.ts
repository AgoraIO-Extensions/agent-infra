import { createHash } from "node:crypto";
import { isAgentManagementText } from "./agent-management-input.js";
import {
	type PersonalApiCredentialErrorCodeV1,
	PersonalApiCredentialErrorV1,
	type PersonalApiCredentialMetadataV1,
	type PersonalApiCredentialRequestV1,
	parsePersonalApiCredentialRequestV1,
	parsePersonalApiCredentialScopesV1,
	requirePersonalApiUserActiveV1,
	requirePersonalApiUserEnabledV1,
	resolveCurrentPersonalApiUserV1,
} from "./personal-api-credentials.js";
import type {
	CurrentTaskUserV1,
	TaskUserDirectoryV1,
} from "./task-authorization.js";

export const personalApiAgentMetadataGrantTypesV1 = ["manage", "use"] as const;

/** Browser Owner, organization membership and administrator roles grant no API access. */
export function isPersonalApiAgentMetadataReadAllowedV1(
	grantTypes: readonly string[],
): boolean {
	return grantTypes.some((grant) => grant === "manage" || grant === "use");
}

export interface PersonalApiAgentReadAuditV1 {
	readonly requestId: string;
	readonly traceId: string;
	readonly userId: string | null;
	readonly credentialId: string | null;
	readonly action: "api.agent.metadata.read";
	readonly outcome: "succeeded" | "failed" | "rejected";
	readonly details: {
		readonly reason?: PersonalApiCredentialErrorCodeV1;
		readonly returnedAgentIds?: readonly string[];
		readonly grantFilter?: "manage_or_use";
	};
}

export interface PersonalApiAgentReadTransactionV1 {
	/** Resolve exactly the used material; duplicate matching hashes are unavailable. */
	lockUsedCredential(credentialHash: string): Promise<
		| (PersonalApiCredentialMetadataV1 & {
				readonly principalType: "user" | "application";
				readonly principalId: string;
		  })
		| null
	>;
	lockUserDisabled(userId: string): Promise<boolean>;
	/** Includes absent grants: concurrent insertion/revocation cannot race the read. */
	lockAgentGrants(): Promise<void>;
	databaseTime(): Promise<Date>;
	markCredentialUsed(credentialId: string, usedAt: Date): Promise<void>;
	recordAudit(event: PersonalApiAgentReadAuditV1): Promise<void>;
}

export interface PersonalApiAgentReadTransactionPortV1 {
	executeAgentRead<T>(
		work: (transaction: PersonalApiAgentReadTransactionV1) => Promise<T>,
	): Promise<T>;
	recordAgentReadAudit(event: PersonalApiAgentReadAuditV1): Promise<void>;
}

function requireUsedCredential(
	credential: PersonalApiCredentialMetadataV1,
	now: Date,
): void {
	if (!Number.isFinite(now.getTime())) {
		throw new PersonalApiCredentialErrorV1("unavailable");
	}
	if (
		credential.revokedAt !== null ||
		(credential.expiresAt !== null &&
			Date.parse(credential.expiresAt) <= now.getTime())
	) {
		throw new PersonalApiCredentialErrorV1("authentication_required");
	}
	if (
		credential.expiresAt !== null &&
		!Number.isFinite(Date.parse(credential.expiresAt))
	) {
		throw new PersonalApiCredentialErrorV1("unavailable");
	}
	let scopes: ReturnType<typeof parsePersonalApiCredentialScopesV1>;
	try {
		scopes = parsePersonalApiCredentialScopesV1(credential.scopes);
	} catch {
		throw new PersonalApiCredentialErrorV1("unavailable");
	}
	if (!scopes.includes("agent:read")) {
		throw new PersonalApiCredentialErrorV1("forbidden");
	}
}

export function createPersonalApiAgentReadUseCaseV1(dependencies: {
	readonly transaction: PersonalApiAgentReadTransactionPortV1;
	readonly userDirectory: TaskUserDirectoryV1;
}) {
	return {
		async recordRefusal(
			metadata: Pick<PersonalApiCredentialRequestV1, "requestId" | "traceId">,
			reason: PersonalApiCredentialErrorCodeV1,
		): Promise<void> {
			try {
				await dependencies.transaction.recordAgentReadAudit({
					...metadata,
					userId: null,
					credentialId: null,
					action: "api.agent.metadata.read",
					outcome: reason === "unavailable" ? "failed" : "rejected",
					details: { reason },
				});
			} catch {
				// Unknown HTTP identities remain unknown, including during audit faults.
			}
		},
		/**
		 * The server's reader applies explicit API grants, never browser discover/Owner.
		 * It runs while the used credential, disable facts and grant writes are locked.
		 * Its result is withheld until the required audit and transaction commit succeed.
		 */
		async readAgents<T>(
			metadata: Pick<PersonalApiCredentialRequestV1, "requestId" | "traceId">,
			material: string,
			readGrantedAgents: (user: CurrentTaskUserV1) => Promise<{
				readonly result: T;
				readonly returnedAgentIds: readonly string[];
			}>,
		): Promise<T> {
			const request = parsePersonalApiCredentialRequestV1({
				...metadata,
				userId: "unknown",
				idempotencyKey: "unkeyed",
			});
			const evidence: { userId: string | null; credentialId: string | null } = {
				userId: null,
				credentialId: null,
			};
			try {
				if (!/^papi_[A-Za-z0-9_-]{43}$/.test(material)) {
					throw new PersonalApiCredentialErrorV1("authentication_required");
				}
				const credentialHash = createHash("sha256")
					.update(material)
					.digest("hex");
				return await dependencies.transaction.executeAgentRead(
					async (transaction) => {
						const credential =
							await transaction.lockUsedCredential(credentialHash);
						if (credential === null) {
							throw new PersonalApiCredentialErrorV1("authentication_required");
						}
						if (!isAgentManagementText(credential.credentialId)) {
							throw new PersonalApiCredentialErrorV1("unavailable");
						}
						evidence.credentialId = credential.credentialId;
						if (credential.principalType !== "user") {
							throw new PersonalApiCredentialErrorV1("authentication_required");
						}
						if (!isAgentManagementText(credential.principalId)) {
							throw new PersonalApiCredentialErrorV1("unavailable");
						}
						evidence.userId = credential.principalId;
						requirePersonalApiUserEnabledV1(
							await transaction.lockUserDisabled(credential.principalId),
						);
						requireUsedCredential(credential, await transaction.databaseTime());
						const first = await resolveCurrentPersonalApiUserV1(
							dependencies.userDirectory,
							credential.principalId,
						);
						requirePersonalApiUserActiveV1(first);
						await transaction.lockAgentGrants();
						const page = await readGrantedAgents(
							Object.freeze({
								...first,
								organizationIds: Object.freeze([...first.organizationIds]),
							}),
						);
						if (
							page.returnedAgentIds.length > 100 ||
							new Set(page.returnedAgentIds).size !==
								page.returnedAgentIds.length ||
							page.returnedAgentIds.some((id) => !isAgentManagementText(id))
						) {
							throw new PersonalApiCredentialErrorV1("unavailable");
						}
						await transaction.recordAudit({
							requestId: request.requestId,
							traceId: request.traceId,
							...evidence,
							action: "api.agent.metadata.read",
							outcome: "succeeded",
							details: {
								returnedAgentIds: [...page.returnedAgentIds],
								grantFilter: "manage_or_use",
							},
						});
						const current = await resolveCurrentPersonalApiUserV1(
							dependencies.userDirectory,
							credential.principalId,
						);
						requirePersonalApiUserActiveV1(current);
						if (current.authorizationRevision !== first.authorizationRevision) {
							throw new PersonalApiCredentialErrorV1("unavailable");
						}
						const usedAt = await transaction.databaseTime();
						requireUsedCredential(credential, usedAt);
						await transaction.markCredentialUsed(
							credential.credentialId,
							usedAt,
						);
						return page.result;
					},
				);
			} catch (error) {
				const failure =
					error instanceof PersonalApiCredentialErrorV1
						? error
						: new PersonalApiCredentialErrorV1("unavailable");
				try {
					await dependencies.transaction.recordAgentReadAudit({
						requestId: request.requestId,
						traceId: request.traceId,
						...evidence,
						action: "api.agent.metadata.read",
						outcome: failure.code === "unavailable" ? "failed" : "rejected",
						details: { reason: failure.code },
					});
				} catch {
					// Store records a sanitized dependency fault; refusal remains refusal.
				}
				throw failure;
			}
		},
	};
}

export type PersonalApiAgentReadUseCaseV1 = ReturnType<
	typeof createPersonalApiAgentReadUseCaseV1
>;
