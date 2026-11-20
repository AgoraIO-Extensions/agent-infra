import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
	type ApprovedConnectionConsumerTargetV1,
	type ApprovedConnectionSystemAccessV1,
	deriveConnectionConsumerProfileV1,
	resolveApprovedConnectionConsumerProfileV1,
} from "../connection-consumer-profile.ts";
import {
	type ConnectionManualDynamicApprovalV1,
	ConnectionManualDynamicApprovalV1Schema,
	type ConnectionManualInstallDescriptorV1,
	ConnectionManualInstallDescriptorV1Schema,
	type ConnectionRegistrationReceiptV1,
	ConnectionRegistrationReceiptV1Schema,
	type ConnectionRegistrationTemplateV1,
	ConnectionRegistrationTemplateV1Schema,
	connectionManualAssociationSourceV1,
	connectionManualSupplyReferenceV1,
} from "./connection-install.ts";
import {
	type RuntimeOAuthConfigurationV1,
	RuntimeOAuthConfigurationV1Schema,
} from "./oauth.ts";
import { runtimeOAuthConfigurationRevisionV1 } from "./oauth-installation-node.ts";
import { canonicalRuntimeRequestSigningPayload } from "./request-signing.ts";

const registrationKeyHashDomain =
	"agent-infra/connection-machine-registration-key/v1\0";

function sha256(value: string): string {
	return createHash("sha256").update(value, "utf8").digest("hex");
}

function canonical(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonical);
	if (value !== null && typeof value === "object")
		return Object.fromEntries(
			Object.entries(value)
				.filter(([, entry]) => entry !== undefined)
				.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
				.map(([key, entry]) => [key, canonical(entry)]),
		);
	return value;
}

/** Sorted-key canonical JSON; the only digest codec used by Worker, Store and Host. */
export function canonicalConnectionInstallJsonV1(value: unknown): string {
	return JSON.stringify(canonical(value));
}

/** Lowercase SHA-256 of the strict template; the AAD `templateDigest`. */
export function connectionRegistrationTemplateDigestV1(
	template: unknown,
): string {
	return sha256(
		canonicalConnectionInstallJsonV1(
			ConnectionRegistrationTemplateV1Schema.parse(template),
		),
	);
}

/** Same domain-separated hash as the Store's EP-1060 key index. */
export function connectionRegistrationKeyHashV1(key: string): string {
	return createHash("sha256")
		.update(registrationKeyHashDomain, "utf8")
		.update(key, "utf8")
		.digest("hex");
}

/** Request digest over every field except the `grant` that signs it. */
export function connectionInstallRequestDigestV1(body: {
	readonly grant?: unknown;
	readonly [key: string]: unknown;
}): string {
	return sha256(
		canonicalRuntimeRequestSigningPayload({ ...body, grant: undefined }),
	);
}

export function connectionInstallConfigurationDigestV1(
	configuration: RuntimeOAuthConfigurationV1,
): string {
	return sha256(
		canonicalConnectionInstallJsonV1(
			RuntimeOAuthConfigurationV1Schema.parse(configuration),
		),
	);
}

export function connectionRegistrationReceiptDigestV1(
	receipt: ConnectionRegistrationReceiptV1,
): string {
	return sha256(
		canonicalConnectionInstallJsonV1(
			ConnectionRegistrationReceiptV1Schema.parse(receipt),
		),
	);
}

/**
 * Deep match of an actual EP-1060 receipt with the original template and key.
 * A first registration must not yet project a principal; every status is ACTIVE.
 */
export function matchConnectionRegistrationReceiptV1(
	value: unknown,
	template: ConnectionRegistrationTemplateV1,
	registrationKey: string,
): ConnectionRegistrationReceiptV1 | undefined {
	const parsed = ConnectionRegistrationReceiptV1Schema.safeParse(value);
	if (!parsed.success) return undefined;
	const receipt = parsed.data;
	const registration = template.registration;
	if (
		receipt.registrationKey !== registrationKey ||
		connectionRegistrationKeyHashV1(registrationKey) !==
			registration.registrationKeyHash ||
		receipt.clientName !== registration.clientName ||
		receipt.redirectUri !== registration.redirectUri ||
		receipt.resource !== registration.resource ||
		receipt.scope !== registration.scope ||
		receipt.configFingerprint !== registration.configFingerprint ||
		!isDeepStrictEqual(receipt.source, registration.source) ||
		receipt.principalId !== null ||
		receipt.status !== "ACTIVE" ||
		receipt.clientStatus !== "ACTIVE" ||
		receipt.instanceStatus !== "ACTIVE" ||
		!Number.isFinite(Date.parse(receipt.createdAt))
	)
		return undefined;
	return receipt;
}

/** Purpose-separated key; the per-Sandbox install token is never a MAC key itself. */
export function connectionInstallReadbackKeyV1(installToken: string): Buffer {
	if (!/^[\x21-\x7e]{32,4096}$/.test(installToken))
		throw new Error("CONNECTION_INSTALL_READBACK_UNAVAILABLE");
	return createHmac("sha256", installToken)
		.update("agent-infra/connection-install-readback-key/v1", "utf8")
		.digest();
}

export function connectionInstallReadbackMacV1(
	key: Uint8Array,
	kind: "request" | "response",
	channelBinding: string,
	bodyDigest: string,
): string {
	if (key.byteLength !== 32)
		throw new Error("CONNECTION_INSTALL_READBACK_UNAVAILABLE");
	return createHmac("sha256", key)
		.update(`agent-infra/connection-install-readback-${kind}/v1\0`, "utf8")
		.update(channelBinding, "utf8")
		.update("\0", "utf8")
		.update(bodyDigest, "utf8")
		.digest("base64url");
}

export function verifyConnectionInstallReadbackMacV1(
	key: Uint8Array,
	kind: "request" | "response",
	channelBinding: string,
	bodyDigest: string,
	mac: string,
): boolean {
	const expected = Buffer.from(
		connectionInstallReadbackMacV1(key, kind, channelBinding, bodyDigest),
	);
	const actual = Buffer.from(mac);
	return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function connectionInstallBodyDigestV1(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

type ApprovedSystemAccess = Extract<
	ApprovedConnectionSystemAccessV1,
	{ status: "available" }
>;

/**
 * Derives the per-Agent Consumer target from approved system access and the
 * verified Owner association (§13.5.1 named source); Worker and Host share it.
 */
export function connectionManualConsumerTargetV1(
	access: ApprovedSystemAccess,
	association: {
		readonly agentId: string;
		readonly connectionAgentId: string;
		readonly associationRevision: number;
	},
): ApprovedConnectionConsumerTargetV1 {
	const derived = deriveConnectionConsumerProfileV1(access, {
		consumerId: association.connectionAgentId,
		source: connectionManualAssociationSourceV1(association),
	});
	const approved = resolveApprovedConnectionConsumerProfileV1(
		derived.profile,
		derived.approval,
	);
	if (approved.status !== "available")
		throw new Error("CONNECTION_INSTALL_TEMPLATE_INVALID");
	return {
		...approved,
		url: approved.profile.publicOrigin + approved.profile.mcpPath,
	};
}

function issuerOrigin(access: ApprovedSystemAccess) {
	const issuer = new URL(access.system.issuer);
	if (
		issuer.protocol !== "https:" ||
		issuer.pathname !== "/" ||
		issuer.origin !== access.system.publicOrigin
	)
		throw new Error("CONNECTION_INSTALL_TEMPLATE_INVALID");
	return issuer.origin;
}

/** Fixed EP-1060 collection endpoint for one Connection Agent. */
export function connectionMachineRegistrationEndpointV1(
	access: ApprovedSystemAccess,
	connectionAgentId: string,
): string {
	return `${issuerOrigin(access)}/connection/v1/agents/${encodeURIComponent(connectionAgentId)}/oauth-clients`;
}

/**
 * Checks every approved, non-secret registration field of a template against the
 * deployment's approved system access. It never trusts a value from the template.
 */
export function verifyConnectionRegistrationTemplateV1(
	value: unknown,
	access: ApprovedSystemAccess,
	clientName: string,
): {
	readonly template: ConnectionRegistrationTemplateV1;
	readonly target: ApprovedConnectionConsumerTargetV1;
} {
	const template = ConnectionRegistrationTemplateV1Schema.parse(value);
	const target = connectionManualConsumerTargetV1(access, {
		agentId: template.reference.agentId,
		connectionAgentId: template.association.connectionAgentId,
		associationRevision: template.association.revision,
	});
	const registration = template.registration;
	if (
		registration.endpoint !==
			connectionMachineRegistrationEndpointV1(
				access,
				template.association.connectionAgentId,
			) ||
		registration.clientName !== clientName ||
		registration.redirectUri !== access.system.oauthCallbackUrl ||
		registration.resource !== target.url ||
		registration.configFingerprint !== target.configFingerprint ||
		!isDeepStrictEqual(registration.source, target.source) ||
		template.systemAccess.configFingerprint !== access.configFingerprint ||
		!isDeepStrictEqual(template.systemAccess.source, access.source) ||
		template.target.sessionGeneration !== template.reference.sessionGeneration
	)
		throw new Error("CONNECTION_INSTALL_TEMPLATE_INVALID");
	return { template, target };
}

/**
 * Worker-side template construction from approved system access and Store
 * facts; the result always passes `verifyConnectionRegistrationTemplateV1`.
 */
export function buildConnectionRegistrationTemplateV1(input: {
	readonly access: ApprovedSystemAccess;
	readonly clientName: string;
	readonly principal: { readonly kind: "user"; readonly id: string };
	readonly reference: ConnectionRegistrationTemplateV1["reference"];
	readonly authorizationId: string;
	readonly confirmationRevision: string;
	readonly association: {
		readonly connectionAgentId: string;
		readonly revision: number;
	};
	readonly claim: { readonly owner: string; readonly fence: number };
	readonly target: ConnectionRegistrationTemplateV1["target"];
	readonly registrationKey: string;
}): ConnectionRegistrationTemplateV1 {
	const target = connectionManualConsumerTargetV1(input.access, {
		agentId: input.reference.agentId,
		connectionAgentId: input.association.connectionAgentId,
		associationRevision: input.association.revision,
	});
	const template = ConnectionRegistrationTemplateV1Schema.parse({
		schemaVersion: 1,
		principal: input.principal,
		reference: input.reference,
		authorizationId: input.authorizationId,
		confirmationRevision: input.confirmationRevision,
		association: input.association,
		claim: input.claim,
		target: input.target,
		systemAccess: {
			configFingerprint: input.access.configFingerprint,
			source: input.access.source,
		},
		registration: {
			endpoint: connectionMachineRegistrationEndpointV1(
				input.access,
				input.association.connectionAgentId,
			),
			clientName: input.clientName,
			redirectUri: input.access.system.oauthCallbackUrl,
			resource: target.url,
			scope: "mcp",
			source: target.source,
			configFingerprint: target.configFingerprint,
			registrationKeyHash: connectionRegistrationKeyHashV1(
				input.registrationKey,
			),
		},
		supply: connectionManualSupplyReferenceV1({
			agentId: input.reference.agentId,
			associationRevision: input.association.revision,
		}),
	});
	return verifyConnectionRegistrationTemplateV1(
		template,
		input.access,
		input.clientName,
	).template;
}

/** Digest the Host signs and reads back for a prepare/status/revoke command. */
export function connectionInstallCommandDigestV1(body: {
	readonly schemaVersion: 1;
	readonly command: "prepare" | "status" | "supply_status" | "revoke";
	readonly commandId: string;
	readonly attemptId: string;
	readonly attemptOwner: string;
	readonly template: ConnectionRegistrationTemplateV1;
	readonly supplyAttemptId: string;
	readonly registrationKey: string;
	readonly expected?: {
		readonly consumerId: string;
		readonly clientId: string;
		readonly instanceId: string;
	};
}): string {
	return connectionInstallRequestDigestV1(body);
}

/** Digest of a first begin body; its nested installation grant is excluded. */
export function connectionInstallFirstBeginBodyDigestV1(body: {
	readonly request: {
		readonly grant?: unknown;
		readonly [key: string]: unknown;
	};
	readonly [key: string]: unknown;
}): string {
	return connectionInstallRequestDigestV1({
		...body,
		request: { ...body.request, grant: undefined },
	});
}

/**
 * Builds the complete per-install OAuth configuration from the CAS-verified
 * receipt. Endpoints are fixed below the approved issuer; the revision is the
 * content digest required by the per-user installation index.
 */
export function connectionManualInstallConfigurationV1(input: {
	readonly access: ApprovedSystemAccess;
	readonly template: ConnectionRegistrationTemplateV1;
	readonly receipt: ConnectionRegistrationReceiptV1;
}): RuntimeOAuthConfigurationV1 {
	const origin = issuerOrigin(input.access);
	const unsigned = {
		schemaVersion: 1 as const,
		ref: `connection-manual-install:${input.template.authorizationId}`,
		revision: "pending",
		clientId: input.receipt.clientId,
		issuer: input.access.system.issuer,
		authorizationEndpoint: `${origin}/oauth/authorize`,
		tokenEndpoint: `${origin}/oauth/token`,
		revocationEndpoint: `${origin}/oauth/revoke`,
		callbackUrl: input.access.system.oauthCallbackUrl,
		runtimeOrigin: input.template.target.runtimeOrigin,
		resource: input.template.registration.resource,
		scope: "mcp" as const,
		configFingerprint: input.template.registration.configFingerprint,
		source: structuredClone(input.template.registration.source),
	};
	const parsed = RuntimeOAuthConfigurationV1Schema.parse(unsigned);
	return RuntimeOAuthConfigurationV1Schema.parse({
		...parsed,
		revision: runtimeOAuthConfigurationRevisionV1(parsed),
	});
}

/**
 * Dynamic manual approvals bound to this approved system access (§13.5.1): the
 * same system access fingerprint and approval source revision, and for a mapping
 * rule the same Connection issuer. Anything else keeps the route closed.
 */
export function resolveConnectionManualDynamicApprovalV1(
	input: unknown,
	access: ApprovedSystemAccess,
): ConnectionManualDynamicApprovalV1 {
	const parsed = ConnectionManualDynamicApprovalV1Schema.safeParse(input);
	if (!parsed.success)
		throw new Error("CONNECTION_MANUAL_DYNAMIC_APPROVAL_INVALID");
	const mapping = parsed.data.principalMapping;
	if (
		mapping.systemAccessFingerprint !== access.configFingerprint ||
		!isDeepStrictEqual(mapping.approvalSource, access.source) ||
		(mapping.kind === "principal_mapping" &&
			mapping.issuer !== access.system.issuer)
	)
		throw new Error("CONNECTION_MANUAL_DYNAMIC_APPROVAL_INVALID");
	return parsed.data;
}

/**
 * Descriptor the first begin fixes (§13.5.6). Within the §13.5.1 exception it
 * names the exception policy and the user's pinned `principalId` (null for the
 * first installation). A mapping rule's expected Principal has no resolver yet,
 * so that approval never produces a descriptor.
 */
export function connectionManualInstallDescriptorV1(input: {
	readonly approval: ConnectionManualDynamicApprovalV1;
	readonly template: ConnectionRegistrationTemplateV1;
	readonly receipt: ConnectionRegistrationReceiptV1;
	readonly configuration: RuntimeOAuthConfigurationV1;
	readonly pinnedPrincipalId: string | null;
}): ConnectionManualInstallDescriptorV1 {
	const mapping = input.approval.principalMapping;
	if (mapping.kind !== "consistency-exception-v1")
		throw new Error("CONNECTION_MANUAL_PRINCIPAL_MAPPING_UNAVAILABLE");
	return ConnectionManualInstallDescriptorV1Schema.parse({
		schemaVersion: 1,
		readbackContract: input.approval.readbackContract,
		registrationKey: input.receipt.registrationKey,
		consumerId: input.receipt.consumerId,
		clientId: input.receipt.clientId,
		instanceId: input.receipt.instanceId,
		configuration: {
			ref: input.configuration.ref,
			revision: input.configuration.revision,
			digest: connectionInstallConfigurationDigestV1(input.configuration),
		},
		principalMapping: {
			kind: mapping.kind,
			policy: mapping.policy,
			pinnedPrincipalId: input.pinnedPrincipalId,
		},
		publicationContract: input.approval.publicationContract,
		supply: input.template.supply,
	});
}

export function connectionManualInstallDescriptorDigestV1(
	descriptor: ConnectionManualInstallDescriptorV1,
): string {
	return sha256(
		canonicalConnectionInstallJsonV1(
			ConnectionManualInstallDescriptorV1Schema.parse(descriptor),
		),
	);
}

/** The descriptor names exactly this installation's receipt, configuration and supply. */
export function connectionManualInstallDescriptorMatchesV1(
	descriptor: ConnectionManualInstallDescriptorV1,
	input: {
		readonly template: ConnectionRegistrationTemplateV1;
		readonly receipt: ConnectionRegistrationReceiptV1;
		readonly configuration: RuntimeOAuthConfigurationV1;
	},
): boolean {
	const parsed =
		ConnectionManualInstallDescriptorV1Schema.safeParse(descriptor);
	return (
		parsed.success &&
		parsed.data.registrationKey === input.receipt.registrationKey &&
		parsed.data.consumerId === input.receipt.consumerId &&
		parsed.data.clientId === input.receipt.clientId &&
		parsed.data.instanceId === input.receipt.instanceId &&
		parsed.data.configuration.ref === input.configuration.ref &&
		parsed.data.configuration.revision === input.configuration.revision &&
		parsed.data.configuration.digest ===
			connectionInstallConfigurationDigestV1(input.configuration) &&
		isDeepStrictEqual(parsed.data.supply, input.template.supply)
	);
}
