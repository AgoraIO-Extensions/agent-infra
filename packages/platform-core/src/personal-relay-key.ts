import type { ApiPrincipalV1 } from "./api-identity.js";

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

export interface PersonalRelayKeyActorV1 {
	readonly userId: string;
	readonly accountStatus: "active" | "disabled";
	readonly principal?: ApiPrincipalV1;
}

export interface PersonalRelayKeyStorePortV1 {
	current(input: {
		readonly actorUserId: string;
		readonly traceId: string;
		readonly requestId: string;
	}): Promise<number | null>;
	replace(input: {
		readonly actorUserId: string;
		readonly expectedVersion: number | null;
		readonly keyValue: string;
		readonly traceId: string;
		readonly requestId: string;
	}): Promise<number | null>;
	revoke(input: {
		readonly actorUserId: string;
		readonly expectedVersion: number;
		readonly traceId: string;
		readonly requestId: string;
	}): Promise<boolean>;
	recordRejected(input: {
		readonly actorUserId: string | null;
		readonly traceId: string;
		readonly requestId: string;
		readonly reason: string;
		readonly outcome: "rejected" | "failed";
	}): Promise<void>;
}

export type PersonalRelayKeyErrorCodeV1 =
	| "not_authorized"
	| "invalid_key"
	| "conflict"
	| "dependency_unavailable";

export class PersonalRelayKeyErrorV1 extends Error {
	constructor(readonly code: PersonalRelayKeyErrorCodeV1) {
		super(code);
		this.name = "PersonalRelayKeyErrorV1";
	}
}

export function personalRelayKeyAuditIntentV1(
	input:
		| { readonly operation: "current" }
		| { readonly operation: "replace"; readonly result: "replaced" | "stale" }
		| { readonly operation: "revoke"; readonly result: "revoked" | "stale" }
		| {
				readonly operation: "rejected";
				readonly outcome: "rejected" | "failed";
				readonly reason: string;
		  },
): {
	readonly action:
		| "relay_key.personal.read"
		| "relay_key.personal.replaced"
		| "relay_key.personal.revoked"
		| "relay_key.personal.rejected";
	readonly outcome: "succeeded" | "rejected" | "failed";
	readonly reason?: string;
} {
	if (input.operation === "current")
		return { action: "relay_key.personal.read", outcome: "succeeded" };
	if (input.operation === "rejected")
		return {
			action: "relay_key.personal.rejected",
			outcome: input.outcome,
			reason: input.reason,
		};
	if (input.result === "stale")
		return {
			action: "relay_key.personal.rejected",
			outcome: "rejected",
			reason: "STALE_VERSION",
		};
	return {
		action:
			input.operation === "replace"
				? "relay_key.personal.replaced"
				: "relay_key.personal.revoked",
		outcome: "succeeded",
	};
}

function subject(actor: PersonalRelayKeyActorV1): string {
	if (actor.accountStatus !== "active" || actor.principal !== undefined)
		throw new PersonalRelayKeyErrorV1("not_authorized");
	return actor.userId;
}

function state(keyVersion: number | null): PersonalRelayKeyStateV1 {
	return keyVersion === null
		? { schemaVersion: 1, isSet: false, keyVersion: null }
		: { schemaVersion: 1, isSet: true, keyVersion };
}

/** The API credential is identity only; a personal Key belongs to the browser user. */
export function createPersonalRelayKeyUseCaseV1(input: {
	readonly store: PersonalRelayKeyStorePortV1;
	readonly validate: (
		keyValue: string,
	) => Promise<"valid" | "invalid" | "unavailable">;
}) {
	const { store, validate } = input;
	return {
		async current(
			actor: PersonalRelayKeyActorV1,
			traceId: string,
			requestId: string,
		): Promise<PersonalRelayKeyStateV1> {
			return state(
				await store.current({
					actorUserId: subject(actor),
					traceId,
					requestId,
				}),
			);
		},
		async replace(
			actor: PersonalRelayKeyActorV1,
			command: {
				readonly expectedVersion: number | null;
				readonly keyValue: string;
			},
			traceId: string,
			requestId: string,
		): Promise<PersonalRelayKeyStateV1> {
			const actorUserId = subject(actor);
			let validity: "valid" | "invalid" | "unavailable";
			try {
				validity = await validate(command.keyValue);
			} catch {
				throw new PersonalRelayKeyErrorV1("dependency_unavailable");
			}
			if (validity === "invalid")
				throw new PersonalRelayKeyErrorV1("invalid_key");
			if (validity !== "valid")
				throw new PersonalRelayKeyErrorV1("dependency_unavailable");
			const keyVersion = await store.replace({
				actorUserId,
				...command,
				traceId,
				requestId,
			});
			if (keyVersion === null) throw new PersonalRelayKeyErrorV1("conflict");
			return state(keyVersion);
		},
		async revoke(
			actor: PersonalRelayKeyActorV1,
			expectedVersion: number,
			traceId: string,
			requestId: string,
		): Promise<PersonalRelayKeyStateV1> {
			if (
				!(await store.revoke({
					actorUserId: subject(actor),
					expectedVersion,
					traceId,
					requestId,
				}))
			)
				throw new PersonalRelayKeyErrorV1("conflict");
			return state(null);
		},
		recordRejected: store.recordRejected.bind(store),
	};
}
