import { z } from "zod";
import { OpaqueIdV1Schema } from "../index.ts";
import {
	RuntimeOAuthAuthorizedRequestV1Schema,
	RuntimeOAuthConfigurationV1Schema,
	RuntimeOAuthGrantClaimsV1Schema,
	RuntimeOAuthOriginalExecutionRefV1Schema,
} from "./oauth.ts";

/**
 * Spec §13.5.5–§13.5.7 first manual Owner Connection OAuth install: the private
 * Worker↔Session Host protocol. Every value here is non-secret; the service
 * credential only crosses as AES-256-GCM ciphertext keyed by a TLS exporter.
 */
export const connectionInstallPathsV1 = {
	supply: "/internal/runtime/connection-install/v1/supply",
	prepare: "/internal/runtime/connection-install/v1/prepare",
	status: "/internal/runtime/connection-install/v1/status",
	supply_status: "/internal/runtime/connection-install/v1/supply-status",
	revoke: "/internal/runtime/connection-install/v1/revoke",
	begin: "/internal/runtime/connection-install/v1/begin",
	beginStatus: "/internal/runtime/connection-install/v1/begin-status",
	/** §13.5.6 exception confirm, phase 1 (contract `connection-manual-confirm/v1`). */
	confirmBindingReadback:
		"/internal/runtime/connection-install/v1/confirm/binding-readback",
	/** §13.5.6 exception confirm, phase 2 (same contract). */
	confirmExchange: "/internal/runtime/connection-install/v1/confirm/exchange",
	readback: "/internal/platform-worker/v1/connection-install/readback",
} as const;

/** RFC 8446 §7.5 exporter labels; each value is derived on both ends of one TLS 1.3 connection. */
export const connectionInstallExporterLabelsV1 = {
	/** Channel binding signed into every Worker→Host install message. */
	channel: "EXPORTER-agent-infra-connection-install-channel-v1",
	/** Transient AES-256-GCM key for the supply ciphertext; context is the AAD. */
	supplyKey: "EXPORTER-agent-infra-connection-host-supply-v1",
	/** Channel binding for the Host→Worker authoritative readback MAC. */
	readback: "EXPORTER-agent-infra-connection-install-readback-v1",
} as const;

export const connectionInstallJwsTypesV1 = {
	supply: "runtime-connection-host-supply+jws",
	registration: "runtime-connection-registration+jws",
	/** The first begin keeps the existing installation JWS contract (§13.5.6). */
	firstBegin: "runtime-connection-installation+jws",
} as const;

/** Readback authorization scheme; the install token itself is never sent. */
export const connectionInstallReadbackAuthSchemeV1 = "AgentInfraInstallProof";
export const connectionInstallReadbackResponseHeaderV1 =
	"x-agent-infra-install-proof";

const hex64 = z.string().regex(/^[a-f0-9]{64}$/);
/** Printable ASCII identifiers; also valid UTF-8 for the shared AAD codec. */
const contextText = z
	.string()
	.min(1)
	.max(512)
	.regex(/^[\x21-\x7e]+$/);
const positive = z.number().int().positive().safe();
const reference = z.strictObject({
	ref: OpaqueIdV1Schema.max(512),
	revision: OpaqueIdV1Schema.max(512),
});
const channelBinding = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const compactJws = z
	.string()
	.max(16384)
	.regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
const installIdentifier = z
	.string()
	.regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
export const ConnectionRegistrationKeyV1Schema = z
	.string()
	.regex(/^[A-Za-z0-9][A-Za-z0-9._~-]{7,127}$/);

function httpsUrl(options: { readonly origin: boolean }) {
	return z
		.string()
		.max(2048)
		.refine((value) => {
			try {
				const url = new URL(value);
				return (
					url.protocol === "https:" &&
					!url.username &&
					!url.password &&
					!url.search &&
					!url.hash &&
					url.href === value &&
					(!options.origin ||
						(url.pathname === "/" &&
							url.port !== "" &&
							Number(url.port) >= 1024))
				);
			} catch {
				return false;
			}
		});
}

/** Host-local trusted identity; Worker derives the same tuple from Store facts. */
export const ConnectionHostInstallTargetV1Schema = z.strictObject({
	deploymentIdentity: contextText,
	/** Original Conversation host session ref recorded by Store and the Host journal. */
	hostRef: contextText,
	sandboxId: contextText,
	podUid: contextText,
	sessionGeneration: positive,
	resourceFence: positive,
	/** Exact install listener origin, `https://<service>.<namespace>.svc:<port>/`. */
	runtimeOrigin: httpsUrl({ origin: true }),
});
export type ConnectionHostInstallTargetV1 = z.infer<
	typeof ConnectionHostInstallTargetV1Schema
>;

/** Exact AAD tuple of `encodeConnectionHostSupplyAadV1`; mirrored for claims parsing. */
export const ConnectionHostSupplyBindingClaimV1Schema = z.strictObject({
	deploymentIdentity: contextText,
	hostRef: contextText,
	sandboxId: contextText,
	podUid: contextText,
	sessionGeneration: positive,
	resourceFence: positive,
	supplyRef: contextText,
	supplyRevision: contextText,
	attemptId: contextText,
	templateDigest: hex64,
});

/**
 * Worker-generated non-secret registration template (§13.5.5). It binds the
 * original user, Agent, Consumer, association and installation revisions, the
 * destination Host and the original claim; its digest is part of the AAD.
 */
export const ConnectionRegistrationTemplateV1Schema = z.strictObject({
	schemaVersion: z.literal(1),
	principal: z.strictObject({ kind: z.literal("user"), id: OpaqueIdV1Schema }),
	reference: RuntimeOAuthOriginalExecutionRefV1Schema,
	authorizationId: OpaqueIdV1Schema,
	confirmationRevision: OpaqueIdV1Schema,
	association: z.strictObject({
		connectionAgentId: z.string().regex(/^[a-z0-9][a-z0-9-]{2,79}$/),
		revision: positive,
	}),
	claim: z.strictObject({ owner: OpaqueIdV1Schema, fence: positive }),
	target: ConnectionHostInstallTargetV1Schema,
	systemAccess: z.strictObject({ configFingerprint: hex64, source: reference }),
	registration: z.strictObject({
		endpoint: httpsUrl({ origin: false }),
		clientName: z.string().min(1).max(100),
		redirectUri: httpsUrl({ origin: false }),
		resource: z.string().min(1).max(2048),
		scope: z.literal("mcp"),
		source: reference,
		configFingerprint: hex64,
		registrationKeyHash: hex64,
	}),
	supply: z.strictObject({ ref: contextText, revision: contextText }),
});
export type ConnectionRegistrationTemplateV1 = z.infer<
	typeof ConnectionRegistrationTemplateV1Schema
>;

/** Exact EP-1060 registration DTO (15 fields); first registration has no principal. */
export const ConnectionRegistrationReceiptV1Schema = z.strictObject({
	registrationKey: ConnectionRegistrationKeyV1Schema,
	clientId: installIdentifier,
	clientName: z.string().min(1).max(100),
	clientStatus: z.string().min(1).max(64),
	configFingerprint: hex64,
	consumerId: installIdentifier,
	createdAt: z.string().min(1).max(64),
	instanceId: installIdentifier,
	instanceStatus: z.string().min(1).max(64),
	principalId: installIdentifier.nullable(),
	redirectUri: z.string().min(1).max(2048),
	resource: z.string().min(1).max(2048),
	scope: z.string().min(1).max(64),
	source: reference,
	status: z.string().min(1).max(64),
});
export type ConnectionRegistrationReceiptV1 = z.infer<
	typeof ConnectionRegistrationReceiptV1Schema
>;

/** Binds an approval to the one-time system access fingerprint and its approval source. */
const systemAccessBinding = {
	systemAccessFingerprint: hex64,
	approvalSource: reference,
};
/** UTC instant written as `YYYY-MM-DDTHH:MM:SS[.sss]Z`. */
const utcInstant = z
	.string()
	.regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/)
	.refine((value) => Number.isFinite(Date.parse(value)));

/**
 * §13.5.1 principal mapping approval for dynamic manual OAuth: the mapping
 * authority, rule, approved Connection issuer and server resolution method.
 */
export const ConnectionPrincipalMappingApprovalV1Schema = z.strictObject({
	schemaVersion: z.literal(1),
	kind: z.literal("principal_mapping"),
	authority: reference,
	rule: reference,
	issuer: httpsUrl({ origin: false }),
	resolution: reference,
	...systemAccessBinding,
});
export type ConnectionPrincipalMappingApprovalV1 = z.infer<
	typeof ConnectionPrincipalMappingApprovalV1Schema
>;

/**
 * §13.5.1 M1 time-limited exception `consistency-exception-v1` (ADR-0047). Every
 * field is required; `connectionRelease` names the Connection release on which
 * the instance-binding precondition was verified.
 */
export const ConnectionConsistencyExceptionApprovalV1Schema = z.strictObject({
	schemaVersion: z.literal(1),
	kind: z.literal("consistency-exception-v1"),
	policy: reference,
	notAfter: utcInstant,
	maximumPinnedPrincipals: positive,
	verificationWindowHours: z.number().int().min(1).max(24),
	connectionRelease: contextText,
	...systemAccessBinding,
});
export type ConnectionConsistencyExceptionApprovalV1 = z.infer<
	typeof ConnectionConsistencyExceptionApprovalV1Schema
>;

/** Deployment approvals a dynamic manual installation fixes in its descriptor (§13.5.6). */
export const ConnectionManualDynamicApprovalV1Schema = z.strictObject({
	schemaVersion: z.literal(1),
	principalMapping: z.discriminatedUnion("kind", [
		ConnectionPrincipalMappingApprovalV1Schema,
		ConnectionConsistencyExceptionApprovalV1Schema,
	]),
	readbackContract: reference,
	publicationContract: reference,
});
export type ConnectionManualDynamicApprovalV1 = z.infer<
	typeof ConnectionManualDynamicApprovalV1Schema
>;

/**
 * §13.5.6 complete non-secret descriptor of a dynamic manual installation,
 * fixed by the first begin. Within the §13.5.1 exception it names the
 * exception policy and the user's pinned `principalId` (null before the first pin).
 */
export const ConnectionManualInstallDescriptorV1Schema = z.strictObject({
	schemaVersion: z.literal(1),
	readbackContract: reference,
	registrationKey: ConnectionRegistrationKeyV1Schema,
	consumerId: installIdentifier,
	clientId: installIdentifier,
	instanceId: installIdentifier,
	configuration: z.strictObject({
		ref: OpaqueIdV1Schema.max(512),
		revision: OpaqueIdV1Schema.max(512),
		digest: hex64,
	}),
	principalMapping: z.discriminatedUnion("kind", [
		z.strictObject({
			kind: z.literal("principal_mapping"),
			rule: reference,
			expectedPrincipalId: installIdentifier,
		}),
		z.strictObject({
			kind: z.literal("consistency-exception-v1"),
			policy: reference,
			pinnedPrincipalId: installIdentifier.nullable(),
		}),
	]),
	publicationContract: reference,
	supply: z.strictObject({ ref: contextText, revision: contextText }),
});
export type ConnectionManualInstallDescriptorV1 = z.infer<
	typeof ConnectionManualInstallDescriptorV1Schema
>;

/** §13.5.6 exception confirm phases; one logical confirm drives both in order. */
export const ConnectionManualConfirmPhaseV1Schema = z.enum([
	"binding_readback",
	"exchange",
]);
export type ConnectionManualConfirmPhaseV1 = z.infer<
	typeof ConnectionManualConfirmPhaseV1Schema
>;

/**
 * §13.5.6 exception confirm, phase 1: the non-secret candidate the Host verified
 * with the EP-1060 readback. It never carries code, verifier or Token material;
 * the Store CAS checks every field against its own facts before the first pin.
 */
export const ConnectionManualConfirmCandidateV1Schema = z.strictObject({
	schemaVersion: z.literal(1),
	principal: z.strictObject({ kind: z.literal("user"), id: OpaqueIdV1Schema }),
	reference: RuntimeOAuthOriginalExecutionRefV1Schema,
	authorizationId: OpaqueIdV1Schema,
	confirmationRevision: OpaqueIdV1Schema,
	association: z.strictObject({
		connectionAgentId: z.string().regex(/^[a-z0-9][a-z0-9-]{2,79}$/),
		revision: positive,
	}),
	confirm: z.strictObject({
		commandId: OpaqueIdV1Schema.max(128),
		phase: z.literal("binding_readback"),
		phaseCommandId: OpaqueIdV1Schema.max(128),
		requestDigest: hex64,
	}),
	target: ConnectionHostInstallTargetV1Schema,
	descriptorDigest: hex64,
	supply: z.strictObject({ ref: contextText, revision: contextText }),
	exceptionPolicy: reference,
	verified: z.strictObject({
		issuer: httpsUrl({ origin: false }),
		registrationKey: ConnectionRegistrationKeyV1Schema,
		principalId: installIdentifier,
		clientId: installIdentifier,
		consumerId: installIdentifier,
		instanceId: installIdentifier,
		redirectUri: httpsUrl({ origin: false }),
		resource: z.string().min(1).max(2048),
		scope: z.literal("mcp"),
		instanceStatus: z.literal("ACTIVE"),
	}),
});
export type ConnectionManualConfirmCandidateV1 = z.infer<
	typeof ConnectionManualConfirmCandidateV1Schema
>;

const envelope = z.strictObject({
	nonce: z.string().max(64),
	ciphertext: z.string().max(12_000),
	tag: z.string().max(64),
});

export const ConnectionHostSupplyRequestV1Schema = z.strictObject({
	schemaVersion: z.literal(1),
	template: ConnectionRegistrationTemplateV1Schema,
	attemptId: contextText,
	envelope,
	grant: compactJws,
});
export type ConnectionHostSupplyRequestV1 = z.infer<
	typeof ConnectionHostSupplyRequestV1Schema
>;

const workerClaims = {
	schemaVersion: z.literal(1),
	audience: z.literal("runtime_connection_install"),
	issuer: OpaqueIdV1Schema,
	workerId: OpaqueIdV1Schema,
	grantId: OpaqueIdV1Schema,
	issuedAt: z.number().int().nonnegative().safe(),
	expiresAt: positive,
	channelBinding,
	requestDigest: hex64,
};

export const ConnectionHostSupplyClaimsV1Schema = z.strictObject({
	...workerClaims,
	purpose: z.literal("connection_host_supply"),
	binding: ConnectionHostSupplyBindingClaimV1Schema,
});
export type ConnectionHostSupplyClaimsV1 = z.infer<
	typeof ConnectionHostSupplyClaimsV1Schema
>;

export const ConnectionInstallCommandV1Schema = z.enum([
	"prepare",
	"status",
	"supply_status",
	"revoke",
]);
const commandAttempt = {
	commandId: OpaqueIdV1Schema.max(128),
	attemptId: OpaqueIdV1Schema.max(128),
	attemptOwner: OpaqueIdV1Schema.max(256),
};

export const ConnectionInstallCommandRequestV1Schema = z.strictObject({
	schemaVersion: z.literal(1),
	command: ConnectionInstallCommandV1Schema,
	...commandAttempt,
	template: ConnectionRegistrationTemplateV1Schema,
	supplyAttemptId: contextText,
	registrationKey: ConnectionRegistrationKeyV1Schema,
	/** Revoke only: the receipt-confirmed client and instance to compare. */
	expected: z
		.strictObject({
			consumerId: installIdentifier,
			clientId: installIdentifier,
			instanceId: installIdentifier,
		})
		.optional(),
	grant: compactJws,
});
export type ConnectionInstallCommandRequestV1 = z.infer<
	typeof ConnectionInstallCommandRequestV1Schema
>;

export const ConnectionInstallCommandClaimsV1Schema = z.strictObject({
	...workerClaims,
	purpose: z.literal("connection_registration"),
	command: z.enum([
		"prepare",
		"status",
		"supply_status",
		"revoke",
		"begin_status",
		"confirm_binding_readback",
		"confirm_exchange",
	]),
	...commandAttempt,
	authorizationId: OpaqueIdV1Schema,
	templateDigest: hex64,
	supplyAttemptId: contextText,
	registrationKeyHash: hex64,
});
export type ConnectionInstallCommandClaimsV1 = z.infer<
	typeof ConnectionInstallCommandClaimsV1Schema
>;

/** `rejected` is definite: the Host sent nothing to Connection for this command. */
export const ConnectionInstallCommandResponseV1Schema = z.discriminatedUnion(
	"outcome",
	[
		z.strictObject({
			schemaVersion: z.literal(1),
			outcome: z.literal("registered"),
			commandId: OpaqueIdV1Schema,
			receipt: ConnectionRegistrationReceiptV1Schema,
		}),
		z.strictObject({
			schemaVersion: z.literal(1),
			outcome: z.literal("revoked"),
			commandId: OpaqueIdV1Schema,
		}),
		z.strictObject({
			schemaVersion: z.literal(1),
			outcome: z.literal("supply_confirmed"),
			commandId: OpaqueIdV1Schema,
		}),
		z.strictObject({
			schemaVersion: z.literal(1),
			outcome: z.literal("unknown"),
			commandId: OpaqueIdV1Schema,
		}),
		z.strictObject({
			schemaVersion: z.literal(1),
			outcome: z.literal("rejected"),
			commandId: OpaqueIdV1Schema,
		}),
	],
);
export type ConnectionInstallCommandResponseV1 = z.infer<
	typeof ConnectionInstallCommandResponseV1Schema
>;

export const ConnectionHostSupplyResponseV1Schema = z.strictObject({
	schemaVersion: z.literal(1),
	outcome: z.literal("confirmed"),
	attemptId: contextText,
	templateDigest: hex64,
});

/** Extra claims carried by the first begin under the existing installation JWS. */
export const ConnectionInstallFirstBeginClaimV1Schema = z.strictObject({
	...commandAttempt,
	templateDigest: hex64,
	supplyAttemptId: contextText,
	registrationKeyHash: hex64,
	receiptDigest: hex64,
	configurationDigest: hex64,
	descriptorDigest: hex64,
	bodyDigest: hex64,
	channelBinding,
});
export const ConnectionInstallFirstBeginGrantClaimsV1Schema =
	RuntimeOAuthGrantClaimsV1Schema.extend({
		command: z.literal("begin"),
		firstBegin: ConnectionInstallFirstBeginClaimV1Schema,
	});
export type ConnectionInstallFirstBeginGrantClaimsV1 = z.infer<
	typeof ConnectionInstallFirstBeginGrantClaimsV1Schema
>;

export const ConnectionInstallFirstBeginRequestV1Schema = z.strictObject({
	schemaVersion: z.literal(1),
	...commandAttempt,
	template: ConnectionRegistrationTemplateV1Schema,
	supplyAttemptId: contextText,
	receipt: ConnectionRegistrationReceiptV1Schema,
	configuration: RuntimeOAuthConfigurationV1Schema,
	descriptor: ConnectionManualInstallDescriptorV1Schema,
	request: RuntimeOAuthAuthorizedRequestV1Schema,
});
export type ConnectionInstallFirstBeginRequestV1 = z.infer<
	typeof ConnectionInstallFirstBeginRequestV1Schema
>;

/** Read-only recovery of the consumed first begin; never generates a new link. */
export const ConnectionInstallBeginStatusRequestV1Schema = z.strictObject({
	schemaVersion: z.literal(1),
	...commandAttempt,
	beginCommandId: OpaqueIdV1Schema.max(128),
	template: ConnectionRegistrationTemplateV1Schema,
	supplyAttemptId: contextText,
	registrationKey: ConnectionRegistrationKeyV1Schema,
	/** Registration JWS with command `begin_status`. */
	grant: compactJws,
});
export type ConnectionInstallBeginStatusRequestV1 = z.infer<
	typeof ConnectionInstallBeginStatusRequestV1Schema
>;

/**
 * §13.5.6 exception confirm, phase 1 (`binding_readback`), new contract
 * `connection-manual-confirm/v1`: the Host only reads EP-1060 back for the
 * installation's key and returns the non-secret candidate. It never reads code
 * or verifier, exchanges or publishes. `commandId` is the phase command.
 */
export const connectionManualConfirmContractV1 = "connection-manual-confirm/v1";
export const ConnectionInstallConfirmBindingReadbackRequestV1Schema =
	z.strictObject({
		schemaVersion: z.literal(1),
		contract: z.literal(connectionManualConfirmContractV1),
		phase: z.literal("binding_readback"),
		confirmCommandId: OpaqueIdV1Schema.max(128),
		...commandAttempt,
		template: ConnectionRegistrationTemplateV1Schema,
		supplyAttemptId: contextText,
		registrationKey: ConnectionRegistrationKeyV1Schema,
		descriptor: ConnectionManualInstallDescriptorV1Schema,
		/** Registration JWS with command `confirm_binding_readback`. */
		grant: compactJws,
	});
export type ConnectionInstallConfirmBindingReadbackRequestV1 = z.infer<
	typeof ConnectionInstallConfirmBindingReadbackRequestV1Schema
>;
export const ConnectionInstallConfirmBindingReadbackResponseV1Schema =
	z.discriminatedUnion("outcome", [
		z.strictObject({
			schemaVersion: z.literal(1),
			contract: z.literal(connectionManualConfirmContractV1),
			outcome: z.literal("candidate"),
			commandId: OpaqueIdV1Schema,
			candidate: ConnectionManualConfirmCandidateV1Schema,
		}),
		z.strictObject({
			schemaVersion: z.literal(1),
			contract: z.literal(connectionManualConfirmContractV1),
			outcome: z.enum(["rejected", "unknown"]),
			commandId: OpaqueIdV1Schema,
		}),
	]);
export type ConnectionInstallConfirmBindingReadbackResponseV1 = z.infer<
	typeof ConnectionInstallConfirmBindingReadbackResponseV1Schema
>;

/**
 * §13.5.6 exception confirm, phase 2 (`exchange`): sent only after this
 * confirm's first-pin receipt committed. It carries the receipt reference and
 * the phase-1 candidate whose digest the receipt fixed; the Host verifies both
 * through the read-only command readback before it reads the binding back
 * again and exchanges the original code once. `commandId` is the phase command.
 */
export const ConnectionInstallConfirmExchangeRequestV1Schema = z.strictObject({
	schemaVersion: z.literal(1),
	contract: z.literal(connectionManualConfirmContractV1),
	phase: z.literal("exchange"),
	confirmCommandId: OpaqueIdV1Schema.max(128),
	...commandAttempt,
	template: ConnectionRegistrationTemplateV1Schema,
	supplyAttemptId: contextText,
	registrationKey: ConnectionRegistrationKeyV1Schema,
	descriptor: ConnectionManualInstallDescriptorV1Schema,
	pinReceipt: z.strictObject({
		id: OpaqueIdV1Schema,
		revision: positive,
		candidateDigest: hex64,
	}),
	candidate: ConnectionManualConfirmCandidateV1Schema,
	/** Registration JWS with command `confirm_exchange`. */
	grant: compactJws,
});
export type ConnectionInstallConfirmExchangeRequestV1 = z.infer<
	typeof ConnectionInstallConfirmExchangeRequestV1Schema
>;
/**
 * `exchanged`: the Host exchanged the original code once and holds the
 * material in its private transaction. `publication` is present only once the
 * Host's private publication committed: the non-secret commit digest and the
 * published material's expiry are the evidence the Platform permit binds; MCP
 * stays closed until that permit exists. `rejected`: the binding no longer
 * matches the pinned candidate, nothing was exchanged.
 */
export const ConnectionInstallConfirmExchangeResponseV1Schema = z.strictObject({
	schemaVersion: z.literal(1),
	contract: z.literal(connectionManualConfirmContractV1),
	outcome: z.enum(["exchanged", "rejected", "unknown"]),
	commandId: OpaqueIdV1Schema,
	/** `expiresAt` is in epoch milliseconds. */
	publication: z
		.strictObject({ commitDigest: hex64, expiresAt: positive })
		.optional(),
});
export type ConnectionInstallConfirmExchangeResponseV1 = z.infer<
	typeof ConnectionInstallConfirmExchangeResponseV1Schema
>;

export const ConnectionInstallReadbackPurposeV1Schema = z.enum([
	"supply",
	"supply_delivery",
	"command",
	/**
	 * §13.5.6 已提交许可读取: a currently approved Execution of the same
	 * installation reads its committed Platform permit; `reference` names that
	 * Execution, not the original one, and the original claim need not live.
	 */
	"permit",
]);

export const ConnectionInstallReadbackRequestV1Schema = z.strictObject({
	schemaVersion: z.literal(1),
	purpose: ConnectionInstallReadbackPurposeV1Schema,
	target: ConnectionHostInstallTargetV1Schema,
	principal: z.strictObject({ kind: z.literal("user"), id: OpaqueIdV1Schema }),
	reference: RuntimeOAuthOriginalExecutionRefV1Schema,
	authorizationId: OpaqueIdV1Schema,
	confirmationRevision: OpaqueIdV1Schema,
	templateDigest: hex64,
	supply: z.strictObject({
		ref: contextText,
		revision: contextText,
		attemptId: contextText,
	}),
	command: z
		.strictObject({
			...commandAttempt,
			command: z.enum([
				"prepare",
				"status",
				"supply_status",
				"revoke",
				"begin",
				"begin_status",
				"confirm_binding_readback",
				"confirm_exchange",
			]),
			requestDigest: hex64,
			registrationKeyHash: hex64,
			/** First begin only: the exact configuration, CAS-verified receipt and descriptor. */
			configurationDigest: hex64.optional(),
			receiptDigest: hex64.optional(),
			descriptorDigest: hex64.optional(),
			/** Exception `confirm_exchange` only: the first-pin receipt it was opened with. */
			pinReceipt: z
				.strictObject({ id: OpaqueIdV1Schema, candidateDigest: hex64 })
				.optional(),
		})
		.optional(),
	/** `permit` purpose only: the committed permit and its publication commit digest. */
	permit: z
		.strictObject({ id: OpaqueIdV1Schema, commitDigest: hex64 })
		.optional(),
	nonce: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
	issuedAt: z.number().int().nonnegative().safe(),
	expiresAt: positive,
});
export type ConnectionInstallReadbackRequestV1 = z.infer<
	typeof ConnectionInstallReadbackRequestV1Schema
>;

export const ConnectionInstallReadbackResponseV1Schema = z.strictObject({
	schemaVersion: z.literal(1),
	outcome: z.enum(["allowed", "denied", "unavailable"]),
	nonce: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
	requestDigest: hex64,
});
export type ConnectionInstallReadbackResponseV1 = z.infer<
	typeof ConnectionInstallReadbackResponseV1Schema
>;

/** Exact Consumer service credential format accepted by the protected Host. */
export const connectionServiceCredentialPatternV1 =
	/^conn_consumer_[\x21-\x7e]{8,4096}$/;

/** Deployment identity shared by Worker policy and Host downward-API facts. */
export function connectionHostDeploymentIdentityV1(input: {
	readonly namespace: string;
	readonly workerId: string;
}): string {
	if (
		!/^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/.test(input.namespace) ||
		!/^[\x21-\x7e]{1,256}$/.test(input.workerId) ||
		input.workerId.includes("/")
	)
		throw new Error("CONNECTION_INSTALL_TARGET_INVALID");
	return `session-sandbox-v1/${input.namespace}/${input.workerId}`;
}

/** Supply reference/revision fixed by the Worker for one manual association. */
export function connectionManualSupplyReferenceV1(input: {
	readonly agentId: string;
	readonly associationRevision: number;
}) {
	if (
		!/^[\x21-\x7e]{1,256}$/.test(input.agentId) ||
		!Number.isSafeInteger(input.associationRevision) ||
		input.associationRevision < 1
	)
		throw new Error("CONNECTION_INSTALL_TARGET_INVALID");
	return {
		ref: `connection-manual-association:${input.agentId}`,
		revision: String(input.associationRevision),
	};
}

/** Profile source naming one association revision (§13.5.1 named source). */
export function connectionManualAssociationSourceV1(input: {
	readonly agentId: string;
	readonly associationRevision: number;
}) {
	return {
		ref: `connection-association:${input.agentId}`,
		revision: String(input.associationRevision),
	};
}
