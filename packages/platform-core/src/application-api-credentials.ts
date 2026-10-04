import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
	isAgentManagementText,
	requireAgentManagementExactKeys,
	snapshotAgentManagementDataObject,
} from "./agent-management-input.js";
import type { ApplicationMaterialGrantMetadataV1 } from "./application-material-grant.js";
import { platformIdempotencyV1 } from "./idempotency.js";
import {
	PersonalApiCredentialErrorV1,
	type PersonalApiCredentialIssuanceV1,
	type PersonalApiCredentialMetadataV1,
	type PersonalApiCredentialRequestV1,
	parsePersonalApiCredentialIssuanceV1,
	parsePersonalApiCredentialRequestV1,
	requirePersonalApiCredentialFutureExpiryV1,
	requirePersonalApiUserActiveV1,
	resolveCurrentPersonalApiUserV1,
} from "./personal-api-credentials.js";
import type { TaskUserDirectoryV1 } from "./task-authorization.js";

export class ApplicationApiCredentialErrorV1 extends Error {
	constructor(
		readonly code:
			| "invalid_input"
			| "forbidden"
			| "not_found"
			| "idempotency_conflict"
			| "unavailable",
	) {
		super("Application API credential operation failed");
		this.name = "ApplicationApiCredentialErrorV1";
	}
}
export interface ApplicationCredentialRecipientV1 {
	readonly principalType: "user" | "application";
	readonly principalId: string;
}
export type ApplicationApiCredentialCommandV1 =
	PersonalApiCredentialIssuanceV1 & {
		readonly recipient: ApplicationCredentialRecipientV1;
	} & (
			| { readonly operation: "issue" }
			| { readonly operation: "rotate"; readonly credentialId: string }
		);
export type ApplicationApiCredentialRequestV1 =
	PersonalApiCredentialRequestV1 & { readonly applicationId: string };
export type ApplicationCredentialDeliveryStatusV1 =
	| "delivery_pending"
	| "delivery_in_flight"
	| "accepted"
	| "failed"
	| "unknown";
export interface ApplicationCredentialDeliveryReceiptV1 {
	readonly attemptId: string;
	readonly recipient: ApplicationCredentialRecipientV1;
	readonly grantRevision: string;
	readonly status: ApplicationCredentialDeliveryStatusV1;
}
export interface ApplicationApiCredentialResultV1 {
	readonly metadata: PersonalApiCredentialMetadataV1 & {
		readonly applicationId: string;
	};
	readonly delivery: ApplicationCredentialDeliveryReceiptV1;
	readonly replayed: boolean;
}
export interface ApplicationCredentialAttemptV1 {
	readonly applicationId: string;
	readonly credentialId: string;
	readonly attemptId: string;
	readonly recipient: ApplicationCredentialRecipientV1;
	readonly expiresAt: string;
}
/** A deployment-owned recipient, not a caller-selected URL. Material stays ephemeral.
 * commit must synchronously fence expired/aborted attempts at its actual acceptance
 * boundary. Merely racing a network promise against a timer does not meet this contract.
 */
export interface ApplicationCredentialDeliveryPortV1 {
	prepare(
		attempt: ApplicationCredentialAttemptV1,
		material: string,
		signal: AbortSignal,
	): Promise<void>;
	commit(
		attempt: ApplicationCredentialAttemptV1,
		signal: AbortSignal,
	): Promise<"accepted" | "unknown">;
	/** Synchronously invalidate the attempt and discard retained material. */
	abort(attempt: ApplicationCredentialAttemptV1): void;
}
export interface ApplicationCredentialSavedReceiptV1 {
	readonly requestDigest: string;
	readonly result: ApplicationApiCredentialResultV1;
	readonly expiresAt: string;
}
export interface ApplicationApiCredentialTransactionV1 {
	databaseTime(): Promise<Date>;
	lockUserDisabled(userId: string): Promise<boolean>;
	lockApplication(applicationId: string): Promise<{
		readonly responsibleUserId: string;
		readonly status: string;
	} | null>;
	lockGrant(
		applicationId: string,
		recipient: ApplicationCredentialRecipientV1,
	): Promise<ApplicationMaterialGrantMetadataV1 | null>;
	lockReceipt(
		request: ApplicationApiCredentialRequestV1,
	): Promise<ApplicationCredentialSavedReceiptV1 | null>;
	lockActiveCredential(
		applicationId: string,
	): Promise<PersonalApiCredentialMetadataV1 | null>;
	insertCredential(
		applicationId: string,
		credentialId: string,
		hash: string,
		command: PersonalApiCredentialIssuanceV1,
	): Promise<PersonalApiCredentialMetadataV1>;
	revokeCredential(credentialId: string, revokedAt: string): Promise<void>;
	saveReceipt(
		request: ApplicationApiCredentialRequestV1,
		receipt: ApplicationCredentialSavedReceiptV1,
	): Promise<void>;
	recordAudit(
		request: ApplicationApiCredentialRequestV1,
		result: ApplicationApiCredentialResultV1,
		event: {
			readonly action:
				| "application.credential.issued"
				| "application.credential.rotated"
				| "application.credential.delivery";
			readonly outcome: "succeeded" | "failed";
			readonly previousCredentialId?: string;
		},
	): Promise<void>;
}
export interface ApplicationApiCredentialStoreV1 {
	/** Every callback shares one SQL transaction, including all authority locks and audit. */
	execute<T>(
		work: (tx: ApplicationApiCredentialTransactionV1) => Promise<T>,
	): Promise<T>;
}

export function parseApplicationApiCredentialCommandV1(
	input: unknown,
): ApplicationApiCredentialCommandV1 {
	try {
		const value = snapshotAgentManagementDataObject(input);
		if (value.operation !== "issue" && value.operation !== "rotate")
			throw new Error();
		requireAgentManagementExactKeys(
			value,
			value.operation === "issue"
				? ["operation", "recipient", "scopes", "expiresAt"]
				: ["operation", "recipient", "scopes", "expiresAt", "credentialId"],
		);
		const recipient = snapshotAgentManagementDataObject(value.recipient);
		requireAgentManagementExactKeys(recipient, [
			"principalType",
			"principalId",
		]);
		if (
			(recipient.principalType !== "user" &&
				recipient.principalType !== "application") ||
			!isAgentManagementText(recipient.principalId)
		)
			throw new Error();
		const issuance = parsePersonalApiCredentialIssuanceV1({
			scopes: value.scopes,
			expiresAt: value.expiresAt,
		});
		const common = {
			...issuance,
			recipient: Object.freeze({
				principalType: recipient.principalType,
				principalId: recipient.principalId,
			}),
		};
		if (value.operation === "issue")
			return Object.freeze({ ...common, operation: "issue" });
		if (!isAgentManagementText(value.credentialId)) throw new Error();
		return Object.freeze({
			...common,
			operation: "rotate",
			credentialId: value.credentialId,
		});
	} catch {
		throw new ApplicationApiCredentialErrorV1("invalid_input");
	}
}
function parseRequest(
	input: ApplicationApiCredentialRequestV1,
): ApplicationApiCredentialRequestV1 {
	try {
		const value = snapshotAgentManagementDataObject(input);
		requireAgentManagementExactKeys(value, [
			"applicationId",
			"userId",
			"requestId",
			"traceId",
			"idempotencyKey",
		]);
		if (!isAgentManagementText(value.applicationId)) throw new Error();
		const { applicationId, ...personal } = value;
		return Object.freeze({
			...parsePersonalApiCredentialRequestV1(personal),
			applicationId,
		});
	} catch {
		throw new ApplicationApiCredentialErrorV1("invalid_input");
	}
}

async function withinDeliveryDeadline<T>(
	attempt: ApplicationCredentialAttemptV1,
	work: (signal: AbortSignal) => Promise<T>,
	delivery: ApplicationCredentialDeliveryPortV1,
): Promise<T> {
	const controller = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(
			() => {
				controller.abort();
				try {
					delivery.abort(attempt);
				} catch {
					/* Keep timeout failure independent of adapter errors. */
				}
				reject(new ApplicationApiCredentialErrorV1("unavailable"));
			},
			Math.max(0, Date.parse(attempt.expiresAt) - Date.now()),
		);
	});
	try {
		if (Date.now() >= Date.parse(attempt.expiresAt))
			throw new ApplicationApiCredentialErrorV1("unavailable");
		return await Promise.race([work(controller.signal), timeout]);
	} finally {
		clearTimeout(timer);
	}
}

export function createApplicationApiCredentialIssuerV1(input: {
	readonly store: ApplicationApiCredentialStoreV1;
	readonly userDirectory: TaskUserDirectoryV1;
	readonly delivery: ApplicationCredentialDeliveryPortV1 | undefined;
}) {
	async function authority(
		tx: ApplicationApiCredentialTransactionV1,
		request: ApplicationApiCredentialRequestV1,
		recipient: ApplicationCredentialRecipientV1,
	) {
		if (await tx.lockUserDisabled(request.userId))
			throw new ApplicationApiCredentialErrorV1("forbidden");
		const manager = await resolveCurrentPersonalApiUserV1(
			input.userDirectory,
			request.userId,
		);
		requirePersonalApiUserActiveV1(manager);
		const application = await tx.lockApplication(request.applicationId);
		if (
			application?.status !== "active" ||
			application.responsibleUserId !== request.userId
		)
			throw new ApplicationApiCredentialErrorV1("not_found");
		if (
			recipient.principalType === "application" &&
			recipient.principalId !== request.applicationId
		)
			throw new ApplicationApiCredentialErrorV1("not_found");
		const grant = await tx.lockGrant(request.applicationId, recipient);
		if (
			!grant ||
			grant.revokedAt !== null ||
			grant.applicationId !== request.applicationId ||
			grant.principalType !== recipient.principalType ||
			grant.principalId !== recipient.principalId
		)
			throw new ApplicationApiCredentialErrorV1("forbidden");
		let recipientRevision: string | null = null;
		if (recipient.principalType === "user") {
			if (await tx.lockUserDisabled(recipient.principalId))
				throw new ApplicationApiCredentialErrorV1("forbidden");
			const user = await resolveCurrentPersonalApiUserV1(
				input.userDirectory,
				recipient.principalId,
			);
			requirePersonalApiUserActiveV1(user);
			recipientRevision = user.authorizationRevision;
		}
		return { grant, manager, recipientRevision };
	}
	async function execute(
		requestInput: ApplicationApiCredentialRequestV1,
		commandInput: unknown,
	): Promise<ApplicationApiCredentialResultV1> {
		const request = parseRequest(requestInput);
		const command = parseApplicationApiCredentialCommandV1(commandInput);
		const delivery = input.delivery;
		if (!delivery) throw new ApplicationApiCredentialErrorV1("unavailable");
		const digest = platformIdempotencyV1.canonicalRequestDigest({
			...command,
			recipient: { ...command.recipient },
		});
		let attempt: ApplicationCredentialAttemptV1 | undefined;
		try {
			const issued = await input.store.execute<
				| {
						result: ApplicationApiCredentialResultV1;
						material?: never;
						expiresAt?: never;
						recipientRevision?: never;
				  }
				| {
						result: ApplicationApiCredentialResultV1;
						material: string;
						expiresAt: string;
						recipientRevision: string | null;
				  }
			>(async (tx) => {
				const first = await authority(tx, request, command.recipient);
				const saved = await tx.lockReceipt(request);
				if (saved) {
					if (saved.requestDigest !== digest)
						throw new ApplicationApiCredentialErrorV1("idempotency_conflict");
					if (
						(saved.result.delivery.status === "delivery_pending" ||
							saved.result.delivery.status === "delivery_in_flight") &&
						(await tx.databaseTime()).getTime() >= Date.parse(saved.expiresAt)
					) {
						const result: ApplicationApiCredentialResultV1 = {
							...saved.result,
							delivery: { ...saved.result.delivery, status: "unknown" },
						};
						await tx.saveReceipt(request, { ...saved, result });
						await tx.recordAudit(request, result, {
							action: "application.credential.delivery",
							outcome: "failed",
						});
						return { result: { ...result, replayed: true } };
					}
					return { result: { ...saved.result, replayed: true } };
				}
				const now = await tx.databaseTime();
				requirePersonalApiCredentialFutureExpiryV1(command, now);
				const old = await tx.lockActiveCredential(request.applicationId);
				if (
					command.operation === "issue"
						? old !== null
						: old?.credentialId !== command.credentialId
				)
					throw new ApplicationApiCredentialErrorV1("idempotency_conflict");
				if (old) await tx.revokeCredential(old.credentialId, now.toISOString());
				const material = `papi_${randomBytes(32).toString("base64url")}`;
				const metadata = await tx.insertCredential(
					request.applicationId,
					randomUUID(),
					createHash("sha256").update(material).digest("hex"),
					command,
				);
				const result: ApplicationApiCredentialResultV1 = {
					metadata: { ...metadata, applicationId: request.applicationId },
					delivery: {
						attemptId: randomUUID(),
						recipient: command.recipient,
						grantRevision: first.grant.authorizationRevision,
						status: "delivery_pending",
					},
					replayed: false,
				};
				const expiresAt = new Date(
					Math.min(
						now.getTime() + 30_000,
						command.expiresAt === null
							? Number.POSITIVE_INFINITY
							: Date.parse(command.expiresAt),
					),
				).toISOString();
				await tx.saveReceipt(request, {
					requestDigest: digest,
					result,
					expiresAt,
				});
				await tx.recordAudit(request, result, {
					action:
						command.operation === "rotate"
							? "application.credential.rotated"
							: "application.credential.issued",
					outcome: "succeeded",
					...(old ? { previousCredentialId: old.credentialId } : {}),
				});
				const last = await authority(tx, request, command.recipient);
				if (
					last.manager.authorizationRevision !==
						first.manager.authorizationRevision ||
					last.grant.authorizationRevision !==
						first.grant.authorizationRevision ||
					last.recipientRevision !== first.recipientRevision
				)
					throw new ApplicationApiCredentialErrorV1("forbidden");
				return {
					result,
					material,
					expiresAt,
					recipientRevision: first.recipientRevision,
				};
			});
			if (issued.material === undefined) return issued.result;
			attempt = {
				applicationId: request.applicationId,
				credentialId: issued.result.metadata.credentialId,
				attemptId: issued.result.delivery.attemptId,
				recipient: command.recipient,
				expiresAt: issued.expiresAt,
			};
			const currentAttempt = attempt;
			await withinDeliveryDeadline(
				currentAttempt,
				(signal) => delivery.prepare(currentAttempt, issued.material, signal),
				delivery,
			);
			await input.store.execute(async (tx) => {
				const current = await authority(tx, request, command.recipient);
				const saved = await tx.lockReceipt(request);
				if (
					!saved ||
					current.recipientRevision !== issued.recipientRevision ||
					saved.result.delivery.attemptId !== currentAttempt.attemptId ||
					saved.result.delivery.status !== "delivery_pending" ||
					current.grant.authorizationRevision !==
						saved.result.delivery.grantRevision ||
					(await tx.databaseTime()).getTime() >= Date.parse(saved.expiresAt)
				)
					throw new ApplicationApiCredentialErrorV1("forbidden");
				await tx.saveReceipt(request, {
					...saved,
					result: {
						...saved.result,
						delivery: {
							...saved.result.delivery,
							status: "delivery_in_flight",
						},
					},
				});
			});
			// Hold application, disable and tuple locks through synchronous consumer acceptance.
			// An in-flight receipt also excludes revocation across a process interruption.
			return await input.store.execute(async (tx) => {
				const current = await authority(tx, request, command.recipient);
				const saved = await tx.lockReceipt(request);
				const credential = await tx.lockActiveCredential(request.applicationId);
				if (
					!saved ||
					current.recipientRevision !== issued.recipientRevision ||
					saved.result.delivery.attemptId !== currentAttempt.attemptId ||
					saved.result.delivery.status !== "delivery_in_flight" ||
					current.grant.authorizationRevision !==
						saved.result.delivery.grantRevision ||
					credential?.credentialId !== currentAttempt.credentialId ||
					(await tx.databaseTime()).getTime() >= Date.parse(saved.expiresAt)
				)
					throw new ApplicationApiCredentialErrorV1("forbidden");
				const status = await withinDeliveryDeadline(
					currentAttempt,
					(signal) => delivery.commit(currentAttempt, signal),
					delivery,
				);
				if (status !== "accepted" && status !== "unknown")
					throw new ApplicationApiCredentialErrorV1("unavailable");
				const result = {
					...saved.result,
					delivery: { ...saved.result.delivery, status },
				};
				await tx.saveReceipt(request, { ...saved, result });
				await tx.recordAudit(request, result, {
					action: "application.credential.delivery",
					outcome: status === "accepted" ? "succeeded" : "failed",
				});
				return result;
			});
		} catch (error) {
			if (attempt) {
				try {
					delivery.abort(attempt);
				} catch {
					/* Unknown stays non-successful and is never retried automatically. */
				}
				const failedAttempt = attempt;
				try {
					await input.store.execute(async (tx) => {
						const saved = await tx.lockReceipt(request);
						if (
							!saved ||
							saved.result.delivery.attemptId !== failedAttempt.attemptId ||
							saved.result.delivery.status === "accepted"
						)
							return;
						const result: ApplicationApiCredentialResultV1 = {
							...saved.result,
							delivery: { ...saved.result.delivery, status: "unknown" },
						};
						await tx.saveReceipt(request, { ...saved, result });
						await tx.recordAudit(request, result, {
							action: "application.credential.delivery",
							outcome: "failed",
						});
					});
				} catch {
					/* The original pending/in-flight receipt still excludes successful replay. */
				}
			}
			if (error instanceof ApplicationApiCredentialErrorV1) throw error;
			if (error instanceof PersonalApiCredentialErrorV1)
				throw new ApplicationApiCredentialErrorV1(
					error.code === "authentication_required" ? "forbidden" : error.code,
				);
			throw new ApplicationApiCredentialErrorV1("unavailable");
		}
	}
	return { execute };
}
