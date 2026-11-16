import { createHash } from "node:crypto";
import { isAgentManagementText } from "./agent-management-input.js";
import {
	type AgentConnectionAssociationStatusV1,
	presentAgentConnectionAssociationV1,
} from "./agent-runtime-presentation.js";
import {
	type ConnectionConsumerRegistrationPolicyV1,
	captureConnectionConsumerRegistrationPolicyV1,
} from "./connection-consumer-registration.js";

/**
 * Owner-managed Connection association (PRD §9.1, Spec §13.5.7). Web and API
 * entries call the same command; only the current Owner may change it.
 */
export class AgentConnectionAssociationErrorV1 extends Error {
	constructor(
		readonly code:
			| "invalid_input"
			| "not_authorized"
			| "conflict"
			/** The Connection Agent ID or service credential is already bound to another Agent. */
			| "already_associated"
			/** Connection did not accept the credential for the submitted Connection Agent ID. */
			| "credential_rejected"
			/** Connection authenticated the credential but the Consumer is not currently usable. */
			| "consumer_unavailable"
			/** Verification result is unknown; nothing was saved. */
			| "verification_unavailable"
			/** The one-time system access does not enable automatic registration. */
			| "automatic_unavailable"
			| "unavailable",
	) {
		super("Agent Connection association operation failed");
		this.name = "AgentConnectionAssociationErrorV1";
	}
}

/** Server-resolved entry. A browser identity is already authenticated; API material is resolved by the Store. */
export type AgentConnectionAssociationEntryV1 =
	| { readonly kind: "browser"; readonly userId: string }
	| { readonly kind: "api"; readonly material: string };

export interface AgentConnectionAssociationRequestV1 {
	readonly entry: AgentConnectionAssociationEntryV1;
	readonly agentId: string;
	readonly traceId: string;
	readonly requestId: string;
}

/** The Agent projection status plus `not_enabled` for an Agent without association. */
export type AgentConnectionAssociationStateStatusV1 =
	| "not_enabled"
	| AgentConnectionAssociationStatusV1;

export interface AgentConnectionAssociationStateV1 {
	readonly schemaVersion: 1;
	readonly status: AgentConnectionAssociationStateStatusV1;
	readonly source: "manual" | "automatic" | null;
	readonly associationRevision: number | null;
	readonly automaticRegistrationAvailable: boolean;
}

/** Current association facts for one Agent, read in the Owner transaction. */
export type AgentConnectionAssociationRecordV1 =
	| {
			readonly source: "manual";
			readonly associationRevision: number;
	  }
	| {
			readonly source: "automatic";
			/** Registration status (pending/sending/registered/failed/unknown). */
			readonly status: string;
			/** Consumer disable status, or null. */
			readonly disableStatus: string | null;
	  };

export interface AgentConnectionAssociationOwnerV1 {
	readonly userId: string;
	readonly agentName: string;
	readonly agentStatus: string;
}

/** Binding for the application ciphertext; the AAD binds Agent, Owner and revision. */
export interface AgentConnectionCredentialBindingV1 {
	readonly agentId: string;
	readonly ownerId: string;
	readonly associationRevision: number;
}

export interface AgentConnectionAssociationAuditV1 {
	readonly agentId: string;
	readonly actorId: string | null;
	readonly traceId: string;
	readonly requestId: string;
	readonly operation:
		| "read"
		| "associate"
		| "replace"
		| "disconnect"
		| "enable";
	readonly outcome: "succeeded" | "rejected" | "failed";
	readonly reason?: AgentConnectionAssociationErrorV1["code"];
	readonly associationRevision?: number;
}

export interface AgentConnectionAssociationTransactionV1 {
	/** Locks the Agent and returns the current Owner, or null for non-Owners and absent Agents. */
	owner(
		entry: AgentConnectionAssociationEntryV1,
		agentId: string,
	): Promise<AgentConnectionAssociationOwnerV1 | null>;
	current(agentId: string): Promise<AgentConnectionAssociationRecordV1 | null>;
	/** True when another Agent already holds this Connection Agent ID or credential. */
	inUseElsewhere(input: {
		readonly agentId: string;
		readonly connectionAgentId: string;
		readonly credentialFingerprint: string;
	}): Promise<boolean>;
	/** Inserts or replaces the manual row and its ciphertext; returns the new revision. */
	saveManual(input: {
		readonly agentId: string;
		readonly ownerId: string;
		readonly connectionAgentId: string;
		readonly credentialFingerprint: string;
		readonly expectedRevision: number | null;
		readonly encrypt: (binding: AgentConnectionCredentialBindingV1) => unknown;
	}): Promise<number | null>;
	/** Deletes the manual row and ciphertext when the revision still matches. */
	deleteManual(agentId: string, expectedRevision: number): Promise<boolean>;
	/** Writes the registration intent and outbox item for an Owner-enabled Agent. */
	enableAutomatic(input: {
		readonly policy: ConnectionConsumerRegistrationPolicyV1;
		readonly agentId: string;
		readonly ownerId: string;
		readonly consumerName: string;
		readonly traceId: string;
		readonly requestId: string;
	}): Promise<void>;
	audit(event: AgentConnectionAssociationAuditV1): Promise<void>;
}

export type ConnectionAssociationVerificationV1 =
	| "verified"
	| "credential_rejected"
	| "consumer_unavailable"
	| "unknown";

export interface AgentConnectionAssociationDependenciesV1 {
	readonly transaction: {
		execute<T>(
			work: (tx: AgentConnectionAssociationTransactionV1) => Promise<T>,
		): Promise<T>;
		recordRefusal(event: AgentConnectionAssociationAuditV1): Promise<void>;
	};
	/**
	 * One read-only Connection call authenticated with the submitted credential
	 * (Spec §13.5.7). Undefined when the deployment has no Connection system access.
	 */
	readonly verify?: (
		input: {
			readonly connectionAgentId: string;
			readonly serviceCredential: string;
		},
		signal: AbortSignal,
	) => Promise<ConnectionAssociationVerificationV1>;
	/** Application ciphertext encryptor (ADR 0002); API holds public keys only. */
	readonly encrypt?: (
		binding: AgentConnectionCredentialBindingV1,
		serviceCredential: string,
	) => unknown;
	readonly registrationPolicy?: ConnectionConsumerRegistrationPolicyV1;
	readonly verificationTimeoutMs?: number;
}

const connectionAgentIdPattern = /^[a-z0-9][a-z0-9-]{2,79}$/;
const credentialPattern = /^[\x21-\x7e]{16,4096}$/;

/** Domain-separated digest used only to reject one credential bound to two Agents. */
export function connectionServiceCredentialFingerprintV1(
	credential: string,
): string {
	return createHash("sha256")
		.update("agent-infra/connection-service-credential/v1\0", "utf8")
		.update(credential, "utf8")
		.digest("hex");
}

/** Fixed ADR 0002 binding: the AAD names this Agent, Owner and association revision. */
export const connectionServiceCredentialSecretNameV1 =
	"connection-service-credential";

export function connectionServiceCredentialSecretInputV1(
	binding: AgentConnectionCredentialBindingV1,
	plaintext: string,
	occurredAt: string,
) {
	return {
		schemaVersion: 1 as const,
		secretId: `${connectionServiceCredentialSecretNameV1}:${binding.agentId}:${binding.associationRevision}`,
		ownerType: "platform" as const,
		ownerId: binding.ownerId,
		agentId: binding.agentId,
		name: connectionServiceCredentialSecretNameV1,
		secretVersion: binding.associationRevision,
		configRevision: binding.associationRevision,
		plaintext,
		occurredAt,
	};
}

function revision(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]) {
	return (
		Object.keys(value).length === keys.length &&
		keys.every((key) => Object.hasOwn(value, key))
	);
}

type ParsedCommand =
	| {
			readonly mode: "manual";
			readonly connectionAgentId: string;
			readonly serviceCredential: string;
			readonly expectedRevision: number | null;
	  }
	| { readonly mode: "automatic" };

function invalid(): never {
	throw new AgentConnectionAssociationErrorV1("invalid_input");
}

function parseCommand(input: unknown): ParsedCommand {
	if (!input || typeof input !== "object" || Array.isArray(input)) invalid();
	const value = input as Record<string, unknown>;
	if (value.schemaVersion !== 1) invalid();
	if (value.mode === "automatic") {
		if (!exactKeys(value, ["schemaVersion", "mode"])) invalid();
		return { mode: "automatic" };
	}
	if (
		value.mode !== "manual" ||
		!exactKeys(value, [
			"schemaVersion",
			"mode",
			"connectionAgentId",
			"serviceCredential",
			"expectedRevision",
		]) ||
		typeof value.connectionAgentId !== "string" ||
		!connectionAgentIdPattern.test(value.connectionAgentId) ||
		typeof value.serviceCredential !== "string" ||
		!credentialPattern.test(value.serviceCredential) ||
		(value.expectedRevision !== null && !revision(value.expectedRevision))
	)
		invalid();
	return {
		mode: "manual",
		connectionAgentId: value.connectionAgentId,
		serviceCredential: value.serviceCredential,
		expectedRevision: value.expectedRevision as number | null,
	};
}

function parseDisconnect(input: unknown): number {
	if (!input || typeof input !== "object" || Array.isArray(input)) invalid();
	const value = input as Record<string, unknown>;
	if (
		!exactKeys(value, ["schemaVersion", "expectedRevision"]) ||
		value.schemaVersion !== 1 ||
		!revision(value.expectedRevision)
	)
		invalid();
	return value.expectedRevision as number;
}

/** Same mapping as the Agent projection (Spec §13.5.7), plus not_enabled. */
export function presentAgentConnectionAssociationStateV1(
	record: AgentConnectionAssociationRecordV1 | null,
	automaticRegistrationAvailable: boolean,
): AgentConnectionAssociationStateV1 {
	const base = {
		schemaVersion: 1 as const,
		automaticRegistrationAvailable,
	};
	if (!record)
		return {
			...base,
			status: "not_enabled",
			source: null,
			associationRevision: null,
		};
	if (record.source === "manual")
		return {
			...base,
			status: "associated",
			source: "manual",
			associationRevision: record.associationRevision,
		};
	const projected = presentAgentConnectionAssociationV1(
		record.status,
		record.disableStatus,
	)?.status;
	if (!projected) throw new AgentConnectionAssociationErrorV1("unavailable");
	return {
		...base,
		status: projected,
		source: "automatic",
		associationRevision: null,
	};
}

/** Agent states in which an Owner may change the Connection association. */
const changeableAgentStatuses = new Set([
	"creating",
	"available",
	"stopped",
	"creation_failed",
]);

export function createAgentConnectionAssociationUseCaseV1(
	input: AgentConnectionAssociationDependenciesV1,
) {
	const policy =
		input.registrationPolicy === undefined
			? undefined
			: captureConnectionConsumerRegistrationPolicyV1(input.registrationPolicy);
	const timeoutMs = input.verificationTimeoutMs ?? 10_000;
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000)
		throw new AgentConnectionAssociationErrorV1("unavailable");

	function trusted(request: AgentConnectionAssociationRequestV1) {
		const entry = request.entry;
		if (
			!isAgentManagementText(request.agentId) ||
			!isAgentManagementText(request.traceId) ||
			!isAgentManagementText(request.requestId) ||
			!entry ||
			(entry.kind === "browser"
				? !isAgentManagementText(entry.userId)
				: entry.kind !== "api" || typeof entry.material !== "string")
		)
			invalid();
		return {
			entry:
				entry.kind === "browser"
					? ({ kind: "browser", userId: entry.userId } as const)
					: ({ kind: "api", material: entry.material } as const),
			agentId: request.agentId,
			traceId: request.traceId,
			requestId: request.requestId,
		};
	}

	async function refuse(
		request: ReturnType<typeof trusted>,
		operation: AgentConnectionAssociationAuditV1["operation"],
		actorId: string | null,
		error: unknown,
	): Promise<never> {
		const failure =
			error instanceof AgentConnectionAssociationErrorV1
				? error
				: new AgentConnectionAssociationErrorV1("unavailable");
		try {
			await input.transaction.recordRefusal({
				agentId: request.agentId,
				actorId:
					actorId ??
					(request.entry.kind === "browser" ? request.entry.userId : null),
				traceId: request.traceId,
				requestId: request.requestId,
				operation,
				outcome:
					failure.code === "unavailable" ||
					failure.code === "verification_unavailable"
						? "failed"
						: "rejected",
				reason: failure.code,
			});
		} catch {
			throw new AgentConnectionAssociationErrorV1("unavailable");
		}
		throw failure;
	}

	async function owned(
		tx: AgentConnectionAssociationTransactionV1,
		request: ReturnType<typeof trusted>,
		change: boolean,
	) {
		const owner = await tx.owner(request.entry, request.agentId);
		if (!owner) throw new AgentConnectionAssociationErrorV1("not_authorized");
		if (
			request.entry.kind === "browser" &&
			owner.userId !== request.entry.userId
		)
			throw new AgentConnectionAssociationErrorV1("not_authorized");
		if (change && !changeableAgentStatuses.has(owner.agentStatus))
			throw new AgentConnectionAssociationErrorV1("conflict");
		return owner;
	}

	async function verify(
		connectionAgentId: string,
		serviceCredential: string,
	): Promise<void> {
		if (!input.verify)
			throw new AgentConnectionAssociationErrorV1("verification_unavailable");
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		let result: ConnectionAssociationVerificationV1;
		try {
			result = await input.verify(
				{ connectionAgentId, serviceCredential },
				controller.signal,
			);
		} catch {
			result = "unknown";
		} finally {
			clearTimeout(timer);
		}
		if (result === "verified") return;
		throw new AgentConnectionAssociationErrorV1(
			result === "credential_rejected"
				? "credential_rejected"
				: result === "consumer_unavailable"
					? "consumer_unavailable"
					: "verification_unavailable",
		);
	}

	async function associateManual(
		request: ReturnType<typeof trusted>,
		command: Extract<ParsedCommand, { mode: "manual" }>,
	) {
		const encrypt = input.encrypt;
		if (!encrypt || !input.verify)
			throw new AgentConnectionAssociationErrorV1("verification_unavailable");
		const credentialFingerprint = connectionServiceCredentialFingerprintV1(
			command.serviceCredential,
		);
		const check = async (tx: AgentConnectionAssociationTransactionV1) => {
			const owner = await owned(tx, request, true);
			const current = await tx.current(request.agentId);
			if (current?.source === "automatic")
				throw new AgentConnectionAssociationErrorV1("conflict");
			const currentRevision =
				current?.source === "manual" ? current.associationRevision : null;
			if (currentRevision !== command.expectedRevision)
				throw new AgentConnectionAssociationErrorV1("conflict");
			if (
				await tx.inUseElsewhere({
					agentId: request.agentId,
					connectionAgentId: command.connectionAgentId,
					credentialFingerprint,
				})
			)
				throw new AgentConnectionAssociationErrorV1("already_associated");
			return owner;
		};
		// Reject non-Owners and stale submissions before any Connection call.
		let actorId: string | null = null;
		try {
			actorId = (await input.transaction.execute(check)).userId;
		} catch (error) {
			return refuse(
				request,
				command.expectedRevision === null ? "associate" : "replace",
				actorId,
				error,
			);
		}
		try {
			await verify(command.connectionAgentId, command.serviceCredential);
			return await input.transaction.execute(async (tx) => {
				const owner = await check(tx);
				const saved = await tx.saveManual({
					agentId: request.agentId,
					ownerId: owner.userId,
					connectionAgentId: command.connectionAgentId,
					credentialFingerprint,
					expectedRevision: command.expectedRevision,
					encrypt: (binding) => {
						if (
							binding.agentId !== request.agentId ||
							binding.ownerId !== owner.userId ||
							!revision(binding.associationRevision)
						)
							throw new AgentConnectionAssociationErrorV1("unavailable");
						return encrypt(binding, command.serviceCredential);
					},
				});
				if (saved === null)
					throw new AgentConnectionAssociationErrorV1("conflict");
				await tx.audit({
					agentId: request.agentId,
					actorId: owner.userId,
					traceId: request.traceId,
					requestId: request.requestId,
					operation:
						command.expectedRevision === null ? "associate" : "replace",
					outcome: "succeeded",
					associationRevision: saved,
				});
				return presentAgentConnectionAssociationStateV1(
					{ source: "manual", associationRevision: saved },
					policy !== undefined,
				);
			});
		} catch (error) {
			return refuse(
				request,
				command.expectedRevision === null ? "associate" : "replace",
				actorId,
				error,
			);
		}
	}

	async function enableAutomatic(request: ReturnType<typeof trusted>) {
		let actorId: string | null = null;
		try {
			if (!policy)
				throw new AgentConnectionAssociationErrorV1("automatic_unavailable");
			const registration = policy;
			return await input.transaction.execute(async (tx) => {
				const owner = await owned(tx, request, true);
				actorId = owner.userId;
				const current = await tx.current(request.agentId);
				if (current?.source === "manual")
					throw new AgentConnectionAssociationErrorV1("conflict");
				if (!current)
					await tx.enableAutomatic({
						policy: registration,
						agentId: request.agentId,
						ownerId: owner.userId,
						consumerName: owner.agentName,
						traceId: request.traceId,
						requestId: request.requestId,
					});
				const state = presentAgentConnectionAssociationStateV1(
					current ?? (await tx.current(request.agentId)),
					true,
				);
				await tx.audit({
					agentId: request.agentId,
					actorId: owner.userId,
					traceId: request.traceId,
					requestId: request.requestId,
					operation: "enable",
					outcome: "succeeded",
				});
				return state;
			});
		} catch (error) {
			return refuse(request, "enable", actorId, error);
		}
	}

	return {
		async current(
			requestInput: AgentConnectionAssociationRequestV1,
		): Promise<AgentConnectionAssociationStateV1> {
			const request = trusted(requestInput);
			let actorId: string | null = null;
			try {
				return await input.transaction.execute(async (tx) => {
					actorId = (await owned(tx, request, false)).userId;
					return presentAgentConnectionAssociationStateV1(
						await tx.current(request.agentId),
						policy !== undefined,
					);
				});
			} catch (error) {
				return refuse(request, "read", actorId, error);
			}
		},
		async associate(
			requestInput: AgentConnectionAssociationRequestV1,
			value: unknown,
		): Promise<AgentConnectionAssociationStateV1> {
			const request = trusted(requestInput);
			let command: ParsedCommand;
			try {
				command = parseCommand(value);
			} catch (error) {
				return refuse(request, "associate", null, error);
			}
			return command.mode === "automatic"
				? enableAutomatic(request)
				: associateManual(request, command);
		},
		async disconnect(
			requestInput: AgentConnectionAssociationRequestV1,
			value: unknown,
		): Promise<AgentConnectionAssociationStateV1> {
			const request = trusted(requestInput);
			let actorId: string | null = null;
			try {
				const expectedRevision = parseDisconnect(value);
				return await input.transaction.execute(async (tx) => {
					const owner = await owned(tx, request, false);
					actorId = owner.userId;
					const current = await tx.current(request.agentId);
					if (
						current?.source !== "manual" ||
						current.associationRevision !== expectedRevision ||
						!(await tx.deleteManual(request.agentId, expectedRevision))
					)
						throw new AgentConnectionAssociationErrorV1("conflict");
					await tx.audit({
						agentId: request.agentId,
						actorId: owner.userId,
						traceId: request.traceId,
						requestId: request.requestId,
						operation: "disconnect",
						outcome: "succeeded",
						associationRevision: expectedRevision,
					});
					return presentAgentConnectionAssociationStateV1(
						null,
						policy !== undefined,
					);
				});
			} catch (error) {
				return refuse(request, "disconnect", actorId, error);
			}
		},
	};
}

export type AgentConnectionAssociationUseCaseV1 = ReturnType<
	typeof createAgentConnectionAssociationUseCaseV1
>;
