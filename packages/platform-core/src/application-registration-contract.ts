export type ApplicationRegistrationErrorCodeV1 =
	| "invalid_input"
	| "authentication_required"
	| "forbidden"
	| "not_found"
	| "idempotency_conflict"
	| "unavailable";
export class ApplicationRegistrationErrorV1 extends Error {
	constructor(readonly code: ApplicationRegistrationErrorCodeV1) {
		super("Application governance operation failed");
		this.name = "ApplicationRegistrationErrorV1";
	}
}
export interface ApplicationMetadataV1 {
	readonly applicationId: string;
	readonly name: string;
	readonly responsibleUserId: string;
	readonly status: "active" | "disabled";
	readonly authorizationRevision: string;
	readonly createdAt: string;
	readonly updatedAt: string;
}
export interface ApplicationRegistrationRequestV1 {
	/** Only the trusted browser boundary supplies this natural person. */
	readonly userId: string;
	readonly requestId: string;
	readonly traceId: string;
}
export interface ApplicationRegistrationAuditV1 {
	readonly requestId: string;
	readonly traceId: string;
	readonly userId: string | null;
	readonly applicationId: string | null;
	readonly action: "application.registered" | "application.metadata.read";
	readonly outcome: "succeeded" | "rejected" | "failed";
	readonly details: {
		readonly reason?: ApplicationRegistrationErrorCodeV1;
		readonly replayed?: boolean;
	};
}
export interface ApplicationRegistrationTransactionV1 {
	lockUserDisabled(userId: string): Promise<boolean>;
	lockIdempotency(
		request: ApplicationRegistrationRequestV1,
		key: string,
	): Promise<{
		readonly requestDigest: string;
		readonly status: string;
		readonly result: unknown;
	} | null>;
	/** Locks only an application owned by this user; foreign and absent IDs are null. */
	readOwn(
		applicationId: string,
		userId: string,
	): Promise<ApplicationMetadataV1 | null>;
	insert(input: {
		readonly applicationId: string;
		readonly name: string;
		readonly responsibleUserId: string;
		readonly authorizationRevision: string;
	}): Promise<ApplicationMetadataV1>;
	completeIdempotency(
		request: ApplicationRegistrationRequestV1,
		key: string,
		digest: string,
		metadata: ApplicationMetadataV1,
	): Promise<void>;
	recordAudit(event: ApplicationRegistrationAuditV1): Promise<void>;
}
export interface ApplicationRegistrationStoreV1 {
	execute<T>(
		work: (transaction: ApplicationRegistrationTransactionV1) => Promise<T>,
	): Promise<T>;
	recordAudit(event: ApplicationRegistrationAuditV1): Promise<void>;
}
