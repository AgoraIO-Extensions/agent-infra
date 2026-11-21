import type { ApplicationMaterialGrantActorV1 } from "./application-material-grant.js";
import { ConnectionInstallationErrorV1 } from "./connection-installation.js";

export type ConnectionPrincipalPinAdministrationErrorCodeV1 =
	| "invalid_input"
	| "authentication_required"
	| "forbidden"
	| "not_found"
	| "conflict"
	| "unavailable";

export class ConnectionPrincipalPinAdministrationErrorV1 extends Error {
	constructor(readonly code: ConnectionPrincipalPinAdministrationErrorCodeV1) {
		super("Connection principal pin operation failed");
		this.name = "ConnectionPrincipalPinAdministrationErrorV1";
	}
}

/**
 * The operator's current first-party facts (Spec §9.1), resolved by the entry
 * from the verified session and the directory, never from the request.
 */
export type ConnectionPrincipalPinOperatorV1 =
	Required<ApplicationMaterialGrantActorV1>;

export interface ConnectionPrincipalPinViewV1 {
	readonly pinId: string;
	readonly userId: string;
	readonly issuer: string;
	readonly principalId: string;
	readonly verificationState: "pending" | "verified" | "mismatch";
	readonly verificationDeadline: string;
	readonly suspended: boolean;
	readonly overdue: boolean;
	readonly releasing: boolean;
	readonly releaseReason: "administrator" | "mismatch" | null;
	readonly released: boolean;
	readonly ruleRevision: number;
}

type StoreRecordInput = {
	readonly pinId: string;
	readonly expectedRuleRevision: number;
	readonly administratorId: string;
	readonly reference: string;
	readonly requestId: string;
	readonly traceId: string;
	readonly beforeCommit: () => Promise<void>;
};

type StoreRecordResult =
	| {
			readonly outcome: "recorded";
			readonly ruleRevision: number;
			readonly closed: number;
	  }
	| { readonly outcome: "stale" | "not_found" };

/** The exception pin Store (§13.5.1 items 4 and 6); it owns the transaction. */
export interface ConnectionPrincipalPinAdministrationStoreV1 {
	read(userId: string): Promise<readonly ConnectionPrincipalPinViewV1[]>;
	requestRelease(input: StoreRecordInput): Promise<StoreRecordResult>;
	recordVerification(
		input: StoreRecordInput & {
			readonly result: "consistent" | "inconsistent";
		},
	): Promise<StoreRecordResult>;
}

interface OperatorRequestV1 {
	readonly requestId: string;
	readonly traceId: string;
	readonly operator: ConnectionPrincipalPinOperatorV1;
}

export interface ConnectionPrincipalPinRecordRequestV1
	extends OperatorRequestV1 {
	readonly pinId: string;
	readonly expectedRuleRevision: number;
	/** https link to the verifier's written conclusion or the unpin request. */
	readonly reference: string;
}

export interface ConnectionPrincipalPinRecordResultV1 {
	readonly pinId: string;
	readonly ruleRevision: number;
	/** Installations closed by this record; their revokes are queued. */
	readonly closedInstallations: number;
}

export interface ConnectionPrincipalPinAdministrationUseCaseV1 {
	read(
		request: OperatorRequestV1 & { readonly userId: string },
	): Promise<readonly ConnectionPrincipalPinViewV1[]>;
	/** Item 6: close and revoke the user's exception installations, then unpin. */
	release(
		request: ConnectionPrincipalPinRecordRequestV1,
	): Promise<ConnectionPrincipalPinRecordResultV1>;
	/** Item 4: the verifier's written conclusion for the pinned Principal. */
	recordVerification(
		request: ConnectionPrincipalPinRecordRequestV1 & {
			readonly result: "consistent" | "inconsistent";
		},
	): Promise<ConnectionPrincipalPinRecordResultV1>;
}

function fail(code: ConnectionPrincipalPinAdministrationErrorCodeV1): never {
	throw new ConnectionPrincipalPinAdministrationErrorV1(code);
}

function text(value: unknown, max = 1024): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= max &&
		value.trim() === value &&
		// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting them is the point.
		!/[\u0000-\u001f\u007f]/u.test(value)
	);
}

function reference(value: unknown): value is string {
	if (!text(value, 512)) return false;
	try {
		const url = new URL(value);
		return (
			url.protocol === "https:" && url.username === "" && url.password === ""
		);
	} catch {
		return false;
	}
}

function assertOperator(request: OperatorRequestV1): void {
	if (!text(request.requestId) || !text(request.traceId)) fail("invalid_input");
	const operator = request.operator;
	if (!text(operator?.userId) || !text(operator.authorizationRevision))
		fail("authentication_required");
	if (operator.accountStatus !== "active") fail("authentication_required");
	if (
		operator.isSystemAdmin !== true ||
		!text(operator.ldapStableUid) ||
		operator.ldapAdministratorConfigured !== true
	)
		fail("forbidden");
}

/**
 * §13.5.1 exception items 4 and 6, the audited operations: only a current
 * `system_admin` (§9.1: active, not disabled on the Platform, LDAP stable UID
 * in the configured allow-list) records a verification or unpins. The operator
 * is re-resolved before the Store and again inside its transaction before
 * commit; any change rolls the record back. Store outcomes keep the CAS: a
 * stale `rule_revision` or a pending release is a conflict, a missing or
 * released pin is unavailable.
 */
export function createConnectionPrincipalPinAdministrationV1(dependencies: {
	readonly store: ConnectionPrincipalPinAdministrationStoreV1;
	/** Current first-party operator facts; missing verification fails closed. */
	readonly resolveCurrentOperator: (
		userId: string,
	) => Promise<ConnectionPrincipalPinOperatorV1 | null>;
}): ConnectionPrincipalPinAdministrationUseCaseV1 {
	const assertCurrent = async (operator: ConnectionPrincipalPinOperatorV1) => {
		let current: ConnectionPrincipalPinOperatorV1 | null;
		try {
			current = await dependencies.resolveCurrentOperator(operator.userId);
		} catch {
			fail("unavailable");
		}
		if (
			current?.userId !== operator.userId ||
			current.accountStatus !== "active" ||
			current.isSystemAdmin !== true ||
			current.ldapStableUid !== operator.ldapStableUid ||
			current.ldapAdministratorConfigured !== true ||
			current.authorizationRevision !== operator.authorizationRevision
		)
			fail("authentication_required");
	};
	const store = async <T>(work: () => Promise<T>): Promise<T> => {
		try {
			return await work();
		} catch (error) {
			if (error instanceof ConnectionPrincipalPinAdministrationErrorV1)
				throw error;
			if (
				error instanceof ConnectionInstallationErrorV1 &&
				error.code === "invalid_input"
			)
				fail("invalid_input");
			fail("unavailable");
		}
	};
	const record = async (
		request: ConnectionPrincipalPinRecordRequestV1,
		write: (input: StoreRecordInput) => Promise<StoreRecordResult>,
	): Promise<ConnectionPrincipalPinRecordResultV1> => {
		assertOperator(request);
		if (
			!text(request.pinId) ||
			!Number.isSafeInteger(request.expectedRuleRevision) ||
			request.expectedRuleRevision < 1 ||
			!reference(request.reference)
		)
			fail("invalid_input");
		await assertCurrent(request.operator);
		const result = await store(() =>
			write({
				pinId: request.pinId,
				expectedRuleRevision: request.expectedRuleRevision,
				administratorId: request.operator.userId,
				reference: request.reference,
				requestId: request.requestId,
				traceId: request.traceId,
				beforeCommit: () => assertCurrent(request.operator),
			}),
		);
		if (result.outcome !== "recorded")
			throw new ConnectionPrincipalPinAdministrationErrorV1(
				result.outcome === "stale" ? "conflict" : "not_found",
			);
		return {
			pinId: request.pinId,
			ruleRevision: result.ruleRevision,
			closedInstallations: result.closed,
		};
	};
	return {
		async read(request) {
			assertOperator(request);
			if (!text(request.userId)) fail("invalid_input");
			await assertCurrent(request.operator);
			return store(() => dependencies.store.read(request.userId));
		},
		release: (request) =>
			record(request, (input) => dependencies.store.requestRelease(input)),
		async recordVerification(request) {
			if (request.result !== "consistent" && request.result !== "inconsistent")
				fail("invalid_input");
			return record(request, (input) =>
				dependencies.store.recordVerification({
					...input,
					result: request.result,
				}),
			);
		},
	};
}
