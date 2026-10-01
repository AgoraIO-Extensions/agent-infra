import {
	isAgentManagementText,
	requireAgentManagementExactKeys,
	snapshotAgentManagementDataObject,
} from "./agent-management-input.js";

export type PersonalRelayKeyStateV1 =
	| {
			readonly schemaVersion: 1;
			readonly isSet: false;
			readonly keyVersion: null;
	  }
	| {
			readonly schemaVersion: 1;
			readonly isSet: true;
			readonly keyVersion: number;
	  };

export type PersonalRelayKeyErrorCodeV1 =
	| "invalid_input"
	| "authentication_required"
	| "not_authorized"
	| "conflict"
	| "unavailable";

export class PersonalRelayKeyErrorV1 extends Error {
	constructor(readonly code: PersonalRelayKeyErrorCodeV1) {
		super("Personal Relay Key operation failed");
		this.name = "PersonalRelayKeyErrorV1";
	}
}

export interface PersonalRelayKeyRequestV1 {
	/** Only the server's authenticated browser session supplies this subject. */
	readonly userId: string;
	readonly traceId: string;
	readonly requestId: string;
}

export interface PersonalRelayKeyIdentityV1 {
	readonly userId: string;
	readonly accountStatus: "active" | "disabled";
	readonly authorizationRevision: string;
}

export interface PersonalRelayKeyBindingV1 {
	readonly purpose: "personal";
	readonly subjectId: string;
	readonly keyId: string;
	readonly keyVersion: number;
}

export type PersonalRelayKeyOperationV1 = "read" | "replace" | "revoke";

export interface PersonalRelayKeyAuditV1 {
	readonly userId: string | null;
	readonly traceId: string;
	readonly requestId: string;
	readonly operation: PersonalRelayKeyOperationV1;
	readonly outcome: "succeeded" | "rejected" | "failed";
	readonly reason?: PersonalRelayKeyErrorCodeV1;
}

/** One Core command runs entirely in the caller's durable Store transaction. */
export interface PersonalRelayKeyTransactionV1 {
	lockUserDisabled(userId: string): Promise<boolean>;
	current(userId: string): Promise<number | null>;
	replace(
		userId: string,
		expectedVersion: number | null,
		encrypt: (binding: PersonalRelayKeyBindingV1) => unknown | Promise<unknown>,
	): Promise<number | null>;
	revoke(userId: string, expectedVersion: number): Promise<boolean>;
	recordAudit(event: PersonalRelayKeyAuditV1): Promise<void>;
}

export interface PersonalRelayKeyTransactionPortV1 {
	/** Results are delivered only after commit, including deferred audit checks. */
	execute<T>(
		work: (transaction: PersonalRelayKeyTransactionV1) => Promise<T>,
	): Promise<T>;
	recordAudit(event: PersonalRelayKeyAuditV1): Promise<void>;
}

function object(input: unknown, keys: readonly string[]) {
	try {
		const values = snapshotAgentManagementDataObject(input);
		// Validate original own keys: the shared copier's plain object can absorb __proto__.
		requireAgentManagementExactKeys(
			Object.getOwnPropertyDescriptors(input),
			keys,
		);
		return values;
	} catch {
		throw new PersonalRelayKeyErrorV1("invalid_input");
	}
}

function version(input: unknown): input is number {
	return Number.isSafeInteger(input) && (input as number) > 0;
}

function request(input: PersonalRelayKeyRequestV1): PersonalRelayKeyRequestV1 {
	const value = object(input, ["userId", "traceId", "requestId"]);
	if (
		!isAgentManagementText(value.userId) ||
		!isAgentManagementText(value.traceId, 256) ||
		!isAgentManagementText(value.requestId, 256)
	)
		throw new PersonalRelayKeyErrorV1("invalid_input");
	return {
		userId: value.userId,
		traceId: value.traceId,
		requestId: value.requestId,
	};
}

function state(keyVersion: number | null): PersonalRelayKeyStateV1 {
	if (keyVersion !== null && !version(keyVersion))
		throw new PersonalRelayKeyErrorV1("unavailable");
	return keyVersion === null
		? { schemaVersion: 1, isSet: false, keyVersion: null }
		: { schemaVersion: 1, isSet: true, keyVersion };
}

function failure(error: unknown): PersonalRelayKeyErrorV1 {
	return error instanceof PersonalRelayKeyErrorV1
		? error
		: new PersonalRelayKeyErrorV1("unavailable");
}

export function createPersonalRelayKeyUseCaseV1(input: {
	readonly transaction: PersonalRelayKeyTransactionPortV1;
	/** Resolve the current request again, never an arbitrary directory subject. */
	readonly currentIdentity: (
		traceId: string,
	) => Promise<PersonalRelayKeyIdentityV1 | null>;
	readonly validate: (
		keyValue: string,
	) => Promise<"valid" | "invalid" | "unavailable">;
	readonly encrypt: (
		binding: PersonalRelayKeyBindingV1,
		keyValue: string,
	) => unknown | Promise<unknown>;
}) {
	async function authorize(
		transaction: PersonalRelayKeyTransactionV1,
		trusted: PersonalRelayKeyRequestV1,
		expectedRevision?: string,
	): Promise<string> {
		if (await transaction.lockUserDisabled(trusted.userId))
			throw new PersonalRelayKeyErrorV1("not_authorized");
		const current = await input.currentIdentity(trusted.traceId);
		if (current === null)
			throw new PersonalRelayKeyErrorV1("authentication_required");
		if (
			!isAgentManagementText(current.userId) ||
			!isAgentManagementText(current.authorizationRevision) ||
			(current.accountStatus !== "active" &&
				current.accountStatus !== "disabled")
		)
			throw new PersonalRelayKeyErrorV1("unavailable");
		if (current.userId !== trusted.userId || current.accountStatus !== "active")
			throw new PersonalRelayKeyErrorV1("not_authorized");
		if (
			expectedRevision !== undefined &&
			current.authorizationRevision !== expectedRevision
		)
			throw new PersonalRelayKeyErrorV1("unavailable");
		return current.authorizationRevision;
	}

	async function recordRefusal(
		metadata: Pick<PersonalRelayKeyRequestV1, "requestId" | "traceId">,
		operation: PersonalRelayKeyOperationV1,
		reason: PersonalRelayKeyErrorCodeV1,
		userId: string | null = null,
	): Promise<void> {
		await input.transaction.recordAudit({
			...metadata,
			userId,
			operation,
			reason,
			outcome: reason === "unavailable" ? "failed" : "rejected",
		});
	}

	async function execute(
		trustedInput: PersonalRelayKeyRequestV1,
		operation: PersonalRelayKeyOperationV1,
		work: (
			transaction: PersonalRelayKeyTransactionV1,
			trusted: PersonalRelayKeyRequestV1,
		) => Promise<PersonalRelayKeyStateV1 | null>,
	): Promise<PersonalRelayKeyStateV1> {
		const trusted = request(trustedInput);
		let staleAudited = false;
		try {
			const result = await input.transaction.execute(async (transaction) => {
				const revision = await authorize(transaction, trusted);
				const value = await work(transaction, trusted);
				await transaction.recordAudit({
					...trusted,
					operation,
					outcome: value === null ? "rejected" : "succeeded",
					...(value === null ? { reason: "conflict" as const } : {}),
				});
				await authorize(transaction, trusted, revision);
				return value;
			});
			if (result === null) {
				staleAudited = true;
				throw new PersonalRelayKeyErrorV1("conflict");
			}
			return result;
		} catch (error) {
			const sanitized = failure(error);
			if (!staleAudited) {
				try {
					await recordRefusal(
						trusted,
						operation,
						sanitized.code,
						trusted.userId,
					);
				} catch {
					throw new PersonalRelayKeyErrorV1("unavailable");
				}
			}
			throw sanitized;
		}
	}

	return {
		current: (trusted: PersonalRelayKeyRequestV1) =>
			execute(trusted, "read", async (transaction, actor) =>
				state(await transaction.current(actor.userId)),
			),
		replace(trusted: PersonalRelayKeyRequestV1, command: unknown) {
			const value = object(command, ["expectedVersion", "keyValue"]);
			if (
				(value.expectedVersion !== null && !version(value.expectedVersion)) ||
				typeof value.keyValue !== "string" ||
				!/^[\x21-\x7e]{16,8192}$/.test(value.keyValue)
			)
				throw new PersonalRelayKeyErrorV1("invalid_input");
			const expectedVersion = value.expectedVersion as number | null;
			const keyValue = value.keyValue;
			return execute(trusted, "replace", async (transaction, actor) => {
				const validity = await input.validate(keyValue);
				if (validity === "invalid")
					throw new PersonalRelayKeyErrorV1("invalid_input");
				if (validity !== "valid")
					throw new PersonalRelayKeyErrorV1("unavailable");
				const replaced = await transaction.replace(
					actor.userId,
					expectedVersion,
					(binding) => input.encrypt(binding, keyValue),
				);
				return replaced === null ? null : state(replaced);
			});
		},
		revoke(trusted: PersonalRelayKeyRequestV1, command: unknown) {
			const value = object(command, ["expectedVersion"]);
			if (!version(value.expectedVersion))
				throw new PersonalRelayKeyErrorV1("invalid_input");
			const expectedVersion = value.expectedVersion;
			return execute(trusted, "revoke", async (transaction, actor) =>
				(await transaction.revoke(actor.userId, expectedVersion))
					? state(null)
					: null,
			);
		},
		recordRefusal,
	};
}
