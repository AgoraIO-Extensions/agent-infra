export interface EmployeeAccount {
	readonly uid: string;
	readonly userId: string;
	readonly email: string;
	readonly displayName: string;
	readonly accountStatus: "active" | "disabled";
	readonly roles: readonly ("employee" | "system_admin")[];
	readonly authorizationRevision: string;
}

export interface EmployeeIdentityDirectory {
	current(uid: string): Promise<EmployeeAccount | null>;
	currentByUserId(userId: string): Promise<EmployeeAccount | null>;
	userIdForUid(uid: string): Promise<string | null>;
}

export type LdapAccount = EmployeeAccount;

/** Historical issuer/UID mapping used to migrate an existing employee without changing their Platform ID. */
export interface LdapIdentityIds {
	findByUid(issuer: string, uid: string): Promise<string | null>;
	findUidByUserId(issuer: string, userId: string): Promise<string | null>;
	getOrCreate(
		issuer: string,
		uid: string,
		/** Used only when this issuer/UID has no existing ID. */
		candidateUserId: string,
	): Promise<string>;
}

export interface EmployeeIdentityFailure {
	readonly stage:
		| "current_status"
		| "service_bind"
		| "service_search"
		| "resolve_account"
		| "identity_id";
	readonly reason:
		| "deadline_expired"
		| "dependency_rejected"
		| "invalid_result";
	readonly deadlineExpired: boolean;
	readonly causeCode?: string;
	readonly elapsedMs: number;
}

export class EmployeeIdentityUnavailableError extends Error {
	readonly failure?: Readonly<EmployeeIdentityFailure>;
	constructor(failure?: EmployeeIdentityFailure) {
		super("LDAP_IDENTITY_UNAVAILABLE");
		if (failure)
			this.failure = Object.freeze({
				stage: failure.stage,
				reason: failure.reason,
				deadlineExpired: failure.deadlineExpired,
				elapsedMs: failure.elapsedMs,
				...(failure.causeCode ? { causeCode: failure.causeCode } : {}),
			});
	}
}

export type LdapIdentityFailure = EmployeeIdentityFailure;
export { EmployeeIdentityUnavailableError as LdapIdentityUnavailableError };
