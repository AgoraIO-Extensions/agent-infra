import { randomUUID } from "node:crypto";
import { isAgentManagementText } from "./agent-management-input.js";

export type ApplicationMaterialGrantPrincipalTypeV1 = "user" | "application";
export type ApplicationMaterialGrantErrorCodeV1 =
	| "invalid_input"
	| "authentication_required"
	| "forbidden"
	| "not_found"
	| "idempotency_conflict"
	| "unavailable";
export class ApplicationMaterialGrantErrorV1 extends Error {
	constructor(readonly code: ApplicationMaterialGrantErrorCodeV1) {
		super("Application material grant operation failed");
		this.name = "ApplicationMaterialGrantErrorV1";
	}
}
export interface ApplicationMaterialGrantActorV1 {
	readonly userId: string;
	readonly accountStatus: "active" | "disabled";
	readonly isSystemAdmin: boolean;
	readonly authorizationRevision: string;
}
export interface ApplicationMaterialGrantRequestV1 {
	readonly requestId: string;
	readonly traceId: string;
	readonly actor: ApplicationMaterialGrantActorV1;
	readonly applicationId: string;
	readonly principalType: ApplicationMaterialGrantPrincipalTypeV1;
	readonly principalId: string;
	readonly expectedRevision?: string;
}
export interface ApplicationMaterialGrantMetadataV1 {
	readonly applicationId: string;
	readonly principalType: ApplicationMaterialGrantPrincipalTypeV1;
	readonly principalId: string;
	readonly authorizationRevision: string;
	readonly createdAt: string;
	readonly revokedAt: string | null;
}
export interface ApplicationMaterialGrantAuditV1 {
	readonly requestId: string;
	readonly traceId: string;
	readonly userId: string | null;
	readonly applicationId: string | null;
	readonly principalType: string | null;
	readonly principalId: string | null;
	readonly action:
		| "api.credential.material.grant"
		| "api.credential.material.revoke"
		| "api.credential.material.read";
	readonly outcome: "succeeded" | "failed" | "rejected";
	readonly details: {
		readonly reason?: ApplicationMaterialGrantErrorCodeV1;
		readonly returnedMaterial?: false;
	};
}
export interface ApplicationMaterialGrantTransactionV1 {
	lockUserDisabled(userId: string): Promise<boolean>;
	applicationExists(applicationId: string): Promise<boolean>;
	recipientEligible(
		principalType: ApplicationMaterialGrantPrincipalTypeV1,
		principalId: string,
	): Promise<boolean>;
	lockGrant(
		request: Pick<
			ApplicationMaterialGrantRequestV1,
			"applicationId" | "principalType" | "principalId"
		>,
	): Promise<ApplicationMaterialGrantMetadataV1 | null>;
	upsertGrant(
		request: ApplicationMaterialGrantRequestV1,
		revision: string,
		createdAt: Date,
	): Promise<ApplicationMaterialGrantMetadataV1>;
	revokeGrant(
		request: ApplicationMaterialGrantRequestV1,
		revokedAt: Date,
		revision: string,
	): Promise<ApplicationMaterialGrantMetadataV1 | null>;
	recordAudit(event: ApplicationMaterialGrantAuditV1): Promise<void>;
}
export interface ApplicationMaterialGrantStoreV1 {
	execute<T>(
		work: (tx: ApplicationMaterialGrantTransactionV1) => Promise<T>,
	): Promise<T>;
}
export interface ApplicationMaterialGrantUseCaseV1 {
	grant(request: ApplicationMaterialGrantRequestV1): Promise<{
		readonly metadata: ApplicationMaterialGrantMetadataV1;
		readonly replayed: boolean;
	}>;
	revoke(request: ApplicationMaterialGrantRequestV1): Promise<{
		readonly metadata: ApplicationMaterialGrantMetadataV1;
		readonly replayed: boolean;
	}>;
	read(
		request: ApplicationMaterialGrantRequestV1,
	): Promise<ApplicationMaterialGrantMetadataV1 | null>;
}
function validText(value: unknown): value is string {
	return typeof value === "string" && isAgentManagementText(value);
}
function assertRequest(request: ApplicationMaterialGrantRequestV1): void {
	if (
		!validText(request.requestId) ||
		!validText(request.traceId) ||
		!validText(request.applicationId) ||
		!validText(request.principalId) ||
		!validText(request.actor.userId) ||
		!validText(request.actor.authorizationRevision)
	)
		throw new ApplicationMaterialGrantErrorV1("invalid_input");
	if (
		request.principalType !== "user" &&
		request.principalType !== "application"
	)
		throw new ApplicationMaterialGrantErrorV1("invalid_input");
}
function assertAdmin(request: ApplicationMaterialGrantRequestV1): void {
	if (request.actor.accountStatus !== "active")
		throw new ApplicationMaterialGrantErrorV1("authentication_required");
	if (!request.actor.isSystemAdmin)
		throw new ApplicationMaterialGrantErrorV1("forbidden");
}
export function createApplicationMaterialGrantUseCaseV1(dependencies: {
	readonly store: ApplicationMaterialGrantStoreV1;
	readonly resolveUser: (
		userId: string,
	) => Promise<{ readonly accountStatus: "active" | "disabled" } | null>;
}): ApplicationMaterialGrantUseCaseV1 {
	const assertRecipient = async (
		tx: ApplicationMaterialGrantTransactionV1,
		request: ApplicationMaterialGrantRequestV1,
	): Promise<void> => {
		if (
			request.principalType === "application" &&
			request.principalId !== request.applicationId
		)
			throw new ApplicationMaterialGrantErrorV1("not_found");
		if (
			!(await tx.recipientEligible(request.principalType, request.principalId))
		)
			throw new ApplicationMaterialGrantErrorV1("not_found");
		if (request.principalType === "user") {
			const user = await dependencies.resolveUser(request.principalId);
			if (user?.accountStatus !== "active")
				throw new ApplicationMaterialGrantErrorV1("not_found");
		}
	};
	return {
		async grant(request) {
			assertRequest(request);
			assertAdmin(request);
			return dependencies.store.execute(async (tx) => {
				if (await tx.lockUserDisabled(request.actor.userId))
					throw new ApplicationMaterialGrantErrorV1("forbidden");
				if (!(await tx.applicationExists(request.applicationId)))
					throw new ApplicationMaterialGrantErrorV1("not_found");
				const current = await tx.lockGrant(request);
				if (
					current &&
					current.authorizationRevision !== request.expectedRevision
				)
					throw new ApplicationMaterialGrantErrorV1("idempotency_conflict");
				await assertRecipient(tx, request);
				if (current?.revokedAt === null) {
					await tx.recordAudit({
						requestId: request.requestId,
						traceId: request.traceId,
						userId: request.actor.userId,
						applicationId: request.applicationId,
						principalType: request.principalType,
						principalId: request.principalId,
						action: "api.credential.material.grant",
						outcome: "succeeded",
						details: { returnedMaterial: false },
					});
					return { metadata: current, replayed: true };
				}
				const metadata = await tx.upsertGrant(
					request,
					randomUUID(),
					new Date(),
				);
				await tx.recordAudit({
					requestId: request.requestId,
					traceId: request.traceId,
					userId: request.actor.userId,
					applicationId: request.applicationId,
					principalType: request.principalType,
					principalId: request.principalId,
					action: "api.credential.material.grant",
					outcome: "succeeded",
					details: { returnedMaterial: false },
				});
				return { metadata, replayed: current?.revokedAt === null };
			});
		},
		async revoke(request) {
			assertRequest(request);
			assertAdmin(request);
			return dependencies.store.execute(async (tx) => {
				if (await tx.lockUserDisabled(request.actor.userId))
					throw new ApplicationMaterialGrantErrorV1("forbidden");
				if (!(await tx.applicationExists(request.applicationId)))
					throw new ApplicationMaterialGrantErrorV1("not_found");
				if (!request.expectedRevision)
					throw new ApplicationMaterialGrantErrorV1("idempotency_conflict");
				const current = await tx.lockGrant(request);
				if (!current) throw new ApplicationMaterialGrantErrorV1("not_found");
				if (
					request.expectedRevision &&
					current.authorizationRevision !== request.expectedRevision
				)
					throw new ApplicationMaterialGrantErrorV1("idempotency_conflict");
				const metadata = await tx.revokeGrant(
					request,
					new Date(),
					randomUUID(),
				);
				if (!metadata) throw new ApplicationMaterialGrantErrorV1("unavailable");
				await tx.recordAudit({
					requestId: request.requestId,
					traceId: request.traceId,
					userId: request.actor.userId,
					applicationId: request.applicationId,
					principalType: request.principalType,
					principalId: request.principalId,
					action: "api.credential.material.revoke",
					outcome: "succeeded",
					details: { returnedMaterial: false },
				});
				return { metadata, replayed: current.revokedAt !== null };
			});
		},
		async read(request) {
			assertRequest(request);
			assertAdmin(request);
			return dependencies.store.execute(async (tx) => {
				if (await tx.lockUserDisabled(request.actor.userId))
					throw new ApplicationMaterialGrantErrorV1("forbidden");
				const current = await tx.lockGrant(request);
				await tx.recordAudit({
					requestId: request.requestId,
					traceId: request.traceId,
					userId: request.actor.userId,
					applicationId: request.applicationId,
					principalType: request.principalType,
					principalId: request.principalId,
					action: "api.credential.material.read",
					outcome: "succeeded",
					details: { returnedMaterial: false },
				});
				return current;
			});
		},
	};
}
