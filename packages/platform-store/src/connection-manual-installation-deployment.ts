import { isDeepStrictEqual } from "node:util";
import { resolveApprovedConnectionSystemAccessV1 } from "@agent-infra/contracts/connection-consumer-profile";
import {
	type ConnectionConsistencyExceptionApprovalV1,
	ConnectionConsistencyExceptionApprovalV1Schema,
} from "@agent-infra/contracts/runtime";
import {
	type ConnectionManualInstallationPolicyInputV1,
	captureConnectionManualInstallationPolicyV1,
} from "./connection-manual-installations.js";
import postgres from "./observed-postgres.js";

/**
 * §13.5.6 readback contract a dynamic manual installation fixes in its
 * descriptor: the EP-1060 registration read by the original key.
 */
export const connectionManualReadbackContractV1 = Object.freeze({
	ref: "connection-ep-1060-read",
	revision: "1",
});

/**
 * §13.5.6 dynamic publication contract (`serviceRef`/`contract` of the
 * dynamic publication receipt). The Host takes the contract body from its
 * protected deployment input and requires the same `ref`/`revision`.
 */
export const connectionManualPublicationContractV1 = Object.freeze({
	ref: "connection-mcp-publication",
	revision: "1",
});

/** EP-1060 `clientName` shown on the Connection consent page unless the deployment names one. */
export const connectionManualClientNameDefaultV1 = "Agent Infra";

/** Printable ASCII, 1–100 characters, no surrounding whitespace (EP-1060 `clientName`). */
export function isConnectionManualClientNameV1(
	value: unknown,
): value is string {
	return (
		typeof value === "string" &&
		/^[\x20-\x7e]{1,100}$/.test(value) &&
		value.trim() === value
	);
}

export type ConnectionManualInstallationDormantReasonV1 =
	| "exception_approval_missing"
	| "exception_approval_invalid"
	| "connection_release_missing"
	| "exception_expired"
	| "system_access_unavailable"
	| "system_access_fingerprint_mismatch"
	| "approval_source_mismatch"
	| "client_name_invalid"
	| "confirmed_principals_unresolvable"
	/** No protected callback delivery to the original Host (§13.5.6). */
	| "callback_delivery_unavailable"
	/** A static or standard installation input shares the deployment; never mixed. */
	| "standard_installation_configured"
	| "policy_invalid";

/**
 * Non-secret facts of an enabled exception route, for the deployment's
 * startup receipt and readback (Spec §13.5.1 item 7 marks; #4199 C2 receipt).
 */
export interface ConnectionManualInstallationReceiptV1 {
	readonly principalMapping: "consistency-exception-v1";
	readonly policy: ConnectionConsistencyExceptionApprovalV1["policy"];
	readonly notAfter: string;
	readonly maximumPinnedPrincipals: number;
	readonly verificationWindowHours: number;
	readonly connectionRelease: string;
	readonly systemAccessFingerprint: string;
	readonly approvalSource: ConnectionConsistencyExceptionApprovalV1["approvalSource"];
	readonly readbackContract: typeof connectionManualReadbackContractV1;
	readonly publicationContract: typeof connectionManualPublicationContractV1;
	readonly clientName: string;
}

export type ConnectionManualInstallationDeploymentV1 =
	| {
			readonly status: "enabled";
			readonly policy: ConnectionManualInstallationPolicyInputV1;
			readonly receipt: ConnectionManualInstallationReceiptV1;
	  }
	| {
			readonly status: "dormant";
			readonly reason: ConnectionManualInstallationDormantReasonV1;
	  };

/** The confirmed-Principal set read from the Platform DB, or why it is not complete. */
export type ConnectionConfirmedPrincipalsV1 =
	| {
			readonly status: "complete";
			readonly principals: ConnectionManualInstallationPolicyInputV1["confirmedPrincipals"];
	  }
	| { readonly status: "unresolvable" };

/**
 * #4199 C2 default-off gate for the §13.5.1 M1 exception route. The route is
 * enabled only when the deployment supplies the approved one-time system
 * access and an exception approval record that passes
 * `ConnectionConsistencyExceptionApprovalV1`, is bound to that system access
 * fingerprint and approval source, names a Connection release and has not
 * reached `notAfter`, and the Platform DB yields the complete set of
 * Principals confirmed outside the exception, and the deployment has a
 * protected callback delivery to the original Host (§13.5.6: without it a
 * confirmed installation would wait for a callback that is never forwarded).
 * Anything else keeps the route dormant with one reason; nothing is defaulted
 * or inferred.
 *
 * The readback and publication contracts are fixed here, not deployment
 * input; the store still enforces `notAfter` on the database clock.
 */
export function resolveConnectionManualInstallationDeploymentV1(input: {
	readonly systemAccess: unknown;
	readonly approval: unknown;
	readonly exceptionApproval: unknown;
	readonly clientName?: unknown;
	readonly confirmedPrincipals: ConnectionConfirmedPrincipalsV1;
	/**
	 * `ready` only when the deployment entry verified the callback-only
	 * credential file or has the deployment module's callback forwarder.
	 */
	readonly callbackDelivery: "ready" | "unavailable";
	readonly now?: number;
}): ConnectionManualInstallationDeploymentV1 {
	const dormant = (reason: ConnectionManualInstallationDormantReasonV1) =>
		({ status: "dormant", reason }) as const;
	if (input.exceptionApproval === undefined || input.exceptionApproval === null)
		return dormant("exception_approval_missing");
	const candidate: unknown = structuredClone(input.exceptionApproval);
	if (typeof candidate !== "object" || Array.isArray(candidate))
		return dormant("exception_approval_invalid");
	const release = (candidate as { connectionRelease?: unknown })
		.connectionRelease;
	if (typeof release !== "string" || release.trim() === "")
		return dormant("connection_release_missing");
	const parsed =
		ConnectionConsistencyExceptionApprovalV1Schema.safeParse(candidate);
	if (!parsed.success) return dormant("exception_approval_invalid");
	const exception = parsed.data;
	const access = resolveApprovedConnectionSystemAccessV1(
		structuredClone(input.systemAccess),
		structuredClone(input.approval),
	);
	if (access.status !== "available")
		return dormant("system_access_unavailable");
	if (exception.systemAccessFingerprint !== access.configFingerprint)
		return dormant("system_access_fingerprint_mismatch");
	if (!isDeepStrictEqual(exception.approvalSource, access.source))
		return dormant("approval_source_mismatch");
	if (Date.parse(exception.notAfter) <= (input.now ?? Date.now()))
		return dormant("exception_expired");
	const clientName = input.clientName ?? connectionManualClientNameDefaultV1;
	if (!isConnectionManualClientNameV1(clientName))
		return dormant("client_name_invalid");
	if (input.confirmedPrincipals.status !== "complete")
		return dormant("confirmed_principals_unresolvable");
	if (input.callbackDelivery !== "ready")
		return dormant("callback_delivery_unavailable");
	const policy: ConnectionManualInstallationPolicyInputV1 = {
		systemAccess: structuredClone(input.systemAccess),
		approval: structuredClone(input.approval),
		clientName,
		dynamic: {
			schemaVersion: 1,
			principalMapping: exception,
			readbackContract: { ...connectionManualReadbackContractV1 },
			publicationContract: { ...connectionManualPublicationContractV1 },
		},
		confirmedPrincipals: structuredClone(input.confirmedPrincipals.principals),
	};
	try {
		captureConnectionManualInstallationPolicyV1(policy);
	} catch {
		return dormant("policy_invalid");
	}
	return {
		status: "enabled",
		policy,
		receipt: {
			principalMapping: "consistency-exception-v1",
			policy: exception.policy,
			notAfter: exception.notAfter,
			maximumPinnedPrincipals: exception.maximumPinnedPrincipals,
			verificationWindowHours: exception.verificationWindowHours,
			connectionRelease: exception.connectionRelease,
			systemAccessFingerprint: exception.systemAccessFingerprint,
			approvalSource: exception.approvalSource,
			readbackContract: connectionManualReadbackContractV1,
			publicationContract: connectionManualPublicationContractV1,
			clientName,
		},
	};
}

/**
 * §13.5.1 exception item 3 / #4199 C2 D4: the Principals confirmed outside the
 * exception, from the Platform DB only, never from deployment configuration.
 * The Platform records no Connection Principal for a standard (non-manual)
 * installation, so any standard installation that is confirmed, or whose
 * result is unknown, makes the set unresolvable and the route stays closed.
 * With none, the complete set is empty. Exception pins are not part of it:
 * the store checks them itself.
 */
export async function readConnectionConfirmedPrincipalsV1(
	databaseUrl: string,
): Promise<ConnectionConfirmedPrincipalsV1> {
	const client = postgres(databaseUrl, { max: 1 });
	try {
		const [row] = await client`
			select exists (
				select 1 from platform.connection_installation_authorizations a
				where a.status in ('confirmed', 'unknown')
					and not exists (select 1 from platform.connection_manual_installations m
						where m.authorization_id = a.id)
			) as standard`;
		if (row?.standard !== false) return { status: "unresolvable" };
		return { status: "complete", principals: [] };
	} catch {
		return { status: "unresolvable" };
	} finally {
		await client.end().catch(() => undefined);
	}
}

const exceptionApprovalEnvironment =
	"AGENT_INFRA_CONNECTION_EXCEPTION_APPROVAL";
const clientNameEnvironment = "AGENT_INFRA_CONNECTION_MANUAL_CLIENT_NAME";

/**
 * Reads the deployment-projected exception approval record and the optional
 * EP-1060 `clientName`. Both are non-secret. An unparsable record is passed on
 * as an invalid value so the gate reports it instead of treating it as absent.
 */
export function readConnectionManualInstallationEnvironmentV1(
	environment: NodeJS.ProcessEnv,
): { readonly exceptionApproval: unknown; readonly clientName?: string } {
	const raw = environment[exceptionApprovalEnvironment];
	let exceptionApproval: unknown;
	if (raw !== undefined && raw !== "") {
		try {
			exceptionApproval = JSON.parse(raw);
		} catch {
			// Present but unreadable: never mistaken for an absent approval.
			exceptionApproval = "unparsable";
		}
	}
	const clientName = environment[clientNameEnvironment];
	return {
		exceptionApproval,
		...(clientName !== undefined && clientName !== "" ? { clientName } : {}),
	};
}
