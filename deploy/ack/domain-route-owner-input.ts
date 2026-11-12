import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export const domainRouteOwnerInputSchemaVersion = 1 as const;
export const selectedDomainRouteAgentIdV1 =
	"agent_api_c54968af289033573b0a25f29a2cae88ff182518286bc7c7b162aad5791b1e4d";
export const selectedDomainRouteOriginV1 =
	"https://apps.agent-infra.agoralab.co";
export const platformDomainRouteOriginV1 =
	"https://agent-infra.agoralab.co";
export const selectedDomainRouteTlsSecretV1 = "agent-infra-apps-tls";
export const selectedDomainRoutePathV1 = `/a/agent-${createHash("sha256")
	.update(selectedDomainRouteAgentIdV1)
	.digest("hex")
	.slice(0, 32)}/`;

type RecordValue = Record<string, unknown>;

export type DomainRoutePkiInputV1 = {
	readonly schemaVersion: 1;
	readonly kind: "ack-domain-route-pki";
	readonly hostname: typeof selectedDomainRouteOriginV1 extends `https://${infer Host}`
		? Host
		: never;
	readonly san: string;
	readonly secretName: typeof selectedDomainRouteTlsSecretV1;
	readonly deliveryRef: string;
	readonly fullchainScope: string;
	readonly publicFingerprint: string;
	readonly expiresAt: string;
	readonly renewalOwner: string;
	readonly renewalMechanism: string;
	readonly issuerType: "external-pki" | "cert-manager";
	readonly acmeAuthorizationRef?: string;
	readonly wildcard: false;
	readonly privateKeyIncluded: false;
};

export type DomainRouteCapsuleInputV1 = {
	readonly schemaVersion: 1;
	readonly kind: "ack-domain-route-capsule";
	readonly sourceSha: string;
	readonly origin: typeof selectedDomainRouteOriginV1;
	readonly platformOrigin: typeof platformDomainRouteOriginV1;
	readonly tlsSecretName: typeof selectedDomainRouteTlsSecretV1;
	readonly agentIds: readonly [typeof selectedDomainRouteAgentIdV1];
	readonly path: typeof selectedDomainRoutePathV1;
	readonly certificateDeliveryRef: string;
	readonly selectedAgentMetadataRef: string;
	readonly prefixCompatibilityRef: string;
	readonly freshCas: {
		readonly namespaceUid: string;
		readonly releaseRevision: string;
		readonly workerSecretUid: string;
		readonly workerSecretResourceVersion: string;
		readonly configurationSha256: string;
		readonly workerImage: string;
	};
	readonly status: "proposal" | "accepted";
	readonly fieldWindowRef?: string;
	readonly wildcard: false;
	readonly sameHostSubstitute: false;
	readonly directApply: false;
	readonly postrendererBypass: false;
};

export type DomainRouteCasV1 = DomainRouteCapsuleInputV1["freshCas"];

export type DomainRouteAgentMetadataV1 = {
	readonly schemaVersion: 1;
	readonly kind: "ack-domain-route-agent-metadata";
	readonly agentId: typeof selectedDomainRouteAgentIdV1;
	readonly managementStatus: string;
	readonly managementRevision: string | number;
	readonly serviceAvailability: string;
	readonly configurationRevision: number;
	readonly source: {
		readonly kind: string;
		readonly interactionMode: "self-managed";
		readonly identityResponsibility: "self-managed";
	};
	readonly imageReference: string;
	readonly interactionUrl: `${typeof selectedDomainRouteOriginV1}${typeof selectedDomainRoutePathV1}${string}`;
	readonly prefixCompatible: true;
	readonly readReceiptRef: string;
};

export type DomainRouteOwnerInputBundleV1 = {
	readonly schemaVersion: 1;
	readonly kind: "ack-domain-route-owner-input";
	readonly pki: DomainRoutePkiInputV1;
	readonly capsule: DomainRouteCapsuleInputV1;
	readonly agent: DomainRouteAgentMetadataV1;
};

export type DomainRouteOwnerValidationReceiptV1 = {
	readonly schemaVersion: 1;
	readonly kind: "ack-domain-route-owner-validation";
	readonly status: "passed";
	readonly sourceSha: string;
	readonly origin: typeof selectedDomainRouteOriginV1;
	readonly path: typeof selectedDomainRoutePathV1;
	readonly pki: { readonly deliveryRef: string; readonly issuerType: string };
	readonly capsule: { readonly status: string; readonly freshCas: true };
	readonly agent: { readonly managementStatus: string; readonly serviceAvailability: string };
	readonly businessVerified: false;
};

function record(value: unknown, code: string): RecordValue {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error(code);
	return value as RecordValue;
}

function stringValue(value: unknown, code: string): string {
	if (typeof value !== "string" || value.length === 0) throw new Error(code);
	return value;
}

function exactString(value: unknown, expected: string, code: string): string {
	if (value !== expected) throw new Error(code);
	return expected;
}

function exactBoolean(value: unknown, expected: false, code: string): false {
	if (value !== expected) throw new Error(code);
	return expected;
}

function version(value: unknown, code: string): 1 {
	if (value !== 1) throw new Error(code);
	return 1;
}

function exactOrigin(value: unknown, expected: string, code: string): string {
	if (value !== expected) throw new Error(code);
	try {
		const parsed = new URL(value);
		if (
			parsed.protocol !== "https:" ||
			parsed.origin !== expected ||
			parsed.pathname !== "/" ||
			parsed.search ||
			parsed.hash ||
			parsed.username ||
			parsed.password
		)
			throw new Error();
	} catch {
		throw new Error(code);
	}
	return expected;
}

function interactionUrl(value: unknown): string {
	if (typeof value !== "string") throw new Error("DOMAIN_ROUTE_AGENT_INTERACTION_URL");
	const expectedPrefix = `${selectedDomainRouteOriginV1}${selectedDomainRoutePathV1}`;
	if (!value.startsWith(expectedPrefix))
		throw new Error("DOMAIN_ROUTE_AGENT_INTERACTION_URL");
	let parsed: URL;
	try {
		parsed = new URL(value);
	} catch {
		throw new Error("DOMAIN_ROUTE_AGENT_INTERACTION_URL");
	}
	if (
		parsed.origin !== selectedDomainRouteOriginV1 ||
		parsed.pathname !== parsed.pathname.normalize("NFC") ||
		!parsed.pathname.startsWith(selectedDomainRoutePathV1) ||
		parsed.username ||
		parsed.password
	)
		throw new Error("DOMAIN_ROUTE_AGENT_INTERACTION_URL");
	const rawPath = value.slice(selectedDomainRouteOriginV1.length).split(/[?#]/u, 1)[0];
	if (rawPath.includes("\\") || rawPath.includes("%") || /(?:^|\/)\.{1,2}(?:\/|$)/u.test(rawPath))
		throw new Error("DOMAIN_ROUTE_AGENT_INTERACTION_URL");
	return value;
}

function noUnknownKeys(value: RecordValue, allowed: readonly string[], code: string) {
	for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(code);
}

export function validateDomainRoutePkiInputV1(value: unknown): DomainRoutePkiInputV1 {
	const input = record(value, "DOMAIN_ROUTE_PKI_INVALID");
	noUnknownKeys(input, [
		"schemaVersion", "kind", "hostname", "san", "secretName", "deliveryRef",
		"fullchainScope", "publicFingerprint", "expiresAt", "renewalOwner",
		"renewalMechanism", "issuerType", "acmeAuthorizationRef", "wildcard",
		"privateKeyIncluded",
	], "DOMAIN_ROUTE_PKI_UNKNOWN_FIELD");
	version(input.schemaVersion, "DOMAIN_ROUTE_PKI_VERSION");
	exactString(input.kind, "ack-domain-route-pki", "DOMAIN_ROUTE_PKI_KIND");
	exactString(input.hostname, "apps.agent-infra.agoralab.co", "DOMAIN_ROUTE_PKI_HOSTNAME");
	exactString(input.san, "apps.agent-infra.agoralab.co", "DOMAIN_ROUTE_PKI_SAN");
	exactString(input.secretName, selectedDomainRouteTlsSecretV1, "DOMAIN_ROUTE_PKI_SECRET");
	for (const [key, code] of [
		["deliveryRef", "DOMAIN_ROUTE_PKI_DELIVERY"],
		["fullchainScope", "DOMAIN_ROUTE_PKI_FULLCHAIN"],
		["publicFingerprint", "DOMAIN_ROUTE_PKI_FINGERPRINT"],
		["expiresAt", "DOMAIN_ROUTE_PKI_EXPIRY"],
		["renewalOwner", "DOMAIN_ROUTE_PKI_RENEWAL_OWNER"],
		["renewalMechanism", "DOMAIN_ROUTE_PKI_RENEWAL_MECHANISM"],
	] as const) stringValue(input[key], code);
	if (input.issuerType !== "external-pki" && input.issuerType !== "cert-manager")
		throw new Error("DOMAIN_ROUTE_PKI_ISSUER");
	if (Object.hasOwn(input, "acmeAuthorizationRef"))
		stringValue(input.acmeAuthorizationRef, "DOMAIN_ROUTE_PKI_ACME_AUTHORIZATION");
	if (input.issuerType === "cert-manager")
		stringValue(input.acmeAuthorizationRef, "DOMAIN_ROUTE_PKI_ACME_AUTHORIZATION");
	exactBoolean(input.wildcard, false, "DOMAIN_ROUTE_PKI_WILDCARD");
	exactBoolean(input.privateKeyIncluded, false, "DOMAIN_ROUTE_PKI_PRIVATE_KEY");
	return input as unknown as DomainRoutePkiInputV1;
}

export function validateDomainRouteCapsuleInputV1(
	value: unknown,
	expectedSourceSha: string,
	expectedCas: DomainRouteCasV1,
): DomainRouteCapsuleInputV1 {
	const input = record(value, "DOMAIN_ROUTE_CAPSULE_INVALID");
	if (!/^[a-f0-9]{40}$/u.test(expectedSourceSha))
		throw new Error("DOMAIN_ROUTE_CAPSULE_EXPECTED_SOURCE");
	noUnknownKeys(input, [
		"schemaVersion", "kind", "sourceSha", "origin", "platformOrigin", "tlsSecretName",
		"agentIds", "path", "certificateDeliveryRef", "selectedAgentMetadataRef",
		"prefixCompatibilityRef", "freshCas", "status", "fieldWindowRef", "wildcard",
		"sameHostSubstitute", "directApply", "postrendererBypass",
	], "DOMAIN_ROUTE_CAPSULE_UNKNOWN_FIELD");
	version(input.schemaVersion, "DOMAIN_ROUTE_CAPSULE_VERSION");
	exactString(input.kind, "ack-domain-route-capsule", "DOMAIN_ROUTE_CAPSULE_KIND");
	exactString(input.sourceSha, expectedSourceSha, "DOMAIN_ROUTE_CAPSULE_SOURCE");
	exactOrigin(input.origin, selectedDomainRouteOriginV1, "DOMAIN_ROUTE_CAPSULE_ORIGIN");
	exactOrigin(input.platformOrigin, platformDomainRouteOriginV1, "DOMAIN_ROUTE_CAPSULE_PLATFORM_ORIGIN");
	if (input.origin === input.platformOrigin) throw new Error("DOMAIN_ROUTE_CAPSULE_SAME_HOST");
	exactString(input.tlsSecretName, selectedDomainRouteTlsSecretV1, "DOMAIN_ROUTE_CAPSULE_SECRET");
	if (!Array.isArray(input.agentIds) || input.agentIds.length !== 1 || input.agentIds[0] !== selectedDomainRouteAgentIdV1)
		throw new Error("DOMAIN_ROUTE_CAPSULE_AGENT_ALLOWLIST");
	exactString(input.path, selectedDomainRoutePathV1, "DOMAIN_ROUTE_CAPSULE_PATH");
	for (const [key, code] of [
		["certificateDeliveryRef", "DOMAIN_ROUTE_CAPSULE_CERTIFICATE"],
		["selectedAgentMetadataRef", "DOMAIN_ROUTE_CAPSULE_AGENT_METADATA"],
		["prefixCompatibilityRef", "DOMAIN_ROUTE_CAPSULE_PREFIX"],
	] as const) stringValue(input[key], code);
	const cas = record(input.freshCas, "DOMAIN_ROUTE_CAPSULE_CAS");
	noUnknownKeys(
		cas,
		[
			"namespaceUid",
			"releaseRevision",
			"workerSecretUid",
			"workerSecretResourceVersion",
			"configurationSha256",
			"workerImage",
		],
		"DOMAIN_ROUTE_CAPSULE_CAS_UNKNOWN_FIELD",
	);
	for (const [key, code] of [
		["namespaceUid", "DOMAIN_ROUTE_CAPSULE_NAMESPACE_UID"],
		["releaseRevision", "DOMAIN_ROUTE_CAPSULE_RELEASE_REVISION"],
		["workerSecretUid", "DOMAIN_ROUTE_CAPSULE_SECRET_UID"],
		["workerSecretResourceVersion", "DOMAIN_ROUTE_CAPSULE_SECRET_RV"],
		["configurationSha256", "DOMAIN_ROUTE_CAPSULE_CONFIGURATION_HASH"],
		["workerImage", "DOMAIN_ROUTE_CAPSULE_WORKER_IMAGE"],
	] as const) stringValue(cas[key], code);
	if (!/^[a-f0-9]{64}$/u.test(cas.configurationSha256))
		throw new Error("DOMAIN_ROUTE_CAPSULE_CONFIGURATION_HASH");
	for (const key of [
		"namespaceUid",
		"releaseRevision",
		"workerSecretUid",
		"workerSecretResourceVersion",
		"configurationSha256",
		"workerImage",
	] as const) {
		if (cas[key] !== expectedCas[key])
			throw new Error("DOMAIN_ROUTE_CAPSULE_CAS_MISMATCH");
	}
	if (input.status !== "proposal" && input.status !== "accepted") throw new Error("DOMAIN_ROUTE_CAPSULE_STATUS");
	if (Object.hasOwn(input, "fieldWindowRef"))
		stringValue(input.fieldWindowRef, "DOMAIN_ROUTE_CAPSULE_FIELD_WINDOW");
	if (input.status === "accepted") stringValue(input.fieldWindowRef, "DOMAIN_ROUTE_CAPSULE_FIELD_WINDOW");
	exactBoolean(input.wildcard, false, "DOMAIN_ROUTE_CAPSULE_WILDCARD");
	exactBoolean(input.sameHostSubstitute, false, "DOMAIN_ROUTE_CAPSULE_SAME_HOST_SUBSTITUTE");
	exactBoolean(input.directApply, false, "DOMAIN_ROUTE_CAPSULE_DIRECT_APPLY");
	exactBoolean(input.postrendererBypass, false, "DOMAIN_ROUTE_CAPSULE_POSTRENDERER");
	return input as unknown as DomainRouteCapsuleInputV1;
}

export function validateDomainRouteAgentMetadataV1(value: unknown): DomainRouteAgentMetadataV1 {
	const input = record(value, "DOMAIN_ROUTE_AGENT_INVALID");
	noUnknownKeys(input, [
		"schemaVersion", "kind", "agentId", "managementStatus", "managementRevision",
		"serviceAvailability", "configurationRevision", "source", "imageReference",
		"interactionUrl", "prefixCompatible", "readReceiptRef",
	], "DOMAIN_ROUTE_AGENT_UNKNOWN_FIELD");
	version(input.schemaVersion, "DOMAIN_ROUTE_AGENT_VERSION");
	exactString(input.kind, "ack-domain-route-agent-metadata", "DOMAIN_ROUTE_AGENT_KIND");
	exactString(input.agentId, selectedDomainRouteAgentIdV1, "DOMAIN_ROUTE_AGENT_ID");
	for (const [key, code] of [
		["managementStatus", "DOMAIN_ROUTE_AGENT_MANAGEMENT_STATUS"],
		["serviceAvailability", "DOMAIN_ROUTE_AGENT_SERVICE_AVAILABILITY"],
		["imageReference", "DOMAIN_ROUTE_AGENT_IMAGE"],
		["readReceiptRef", "DOMAIN_ROUTE_AGENT_RECEIPT"],
	] as const) stringValue(input[key], code);
	if (!Number.isSafeInteger(input.configurationRevision) || input.configurationRevision < 1)
		throw new Error("DOMAIN_ROUTE_AGENT_CONFIGURATION_REVISION");
	const source = record(input.source, "DOMAIN_ROUTE_AGENT_SOURCE");
	noUnknownKeys(
		source,
		["kind", "interactionMode", "identityResponsibility"],
		"DOMAIN_ROUTE_AGENT_SOURCE_UNKNOWN_FIELD",
	);
	stringValue(source.kind, "DOMAIN_ROUTE_AGENT_SOURCE_KIND");
	if (
		!(typeof input.managementRevision === "string" && input.managementRevision.length > 0) &&
		!(Number.isSafeInteger(input.managementRevision) && input.managementRevision >= 0)
	)
		throw new Error("DOMAIN_ROUTE_AGENT_MANAGEMENT_REVISION");
	exactString(source.interactionMode, "self-managed", "DOMAIN_ROUTE_AGENT_MODE");
	exactString(source.identityResponsibility, "self-managed", "DOMAIN_ROUTE_AGENT_IDENTITY");
	interactionUrl(input.interactionUrl);
	if (input.prefixCompatible !== true) throw new Error("DOMAIN_ROUTE_AGENT_PREFIX");
	return input as unknown as DomainRouteAgentMetadataV1;
}

export function validateDomainRouteOwnerInputBundleV1(
	value: unknown,
	expectedSourceSha: string,
	expectedCas: DomainRouteCasV1,
): DomainRouteOwnerValidationReceiptV1 {
	const input = record(value, "DOMAIN_ROUTE_OWNER_INPUT_INVALID");
	noUnknownKeys(input, ["schemaVersion", "kind", "pki", "capsule", "agent"], "DOMAIN_ROUTE_OWNER_UNKNOWN_FIELD");
	version(input.schemaVersion, "DOMAIN_ROUTE_OWNER_VERSION");
	exactString(input.kind, "ack-domain-route-owner-input", "DOMAIN_ROUTE_OWNER_KIND");
	const pki = validateDomainRoutePkiInputV1(input.pki);
	const capsule = validateDomainRouteCapsuleInputV1(input.capsule, expectedSourceSha, expectedCas);
	const agent = validateDomainRouteAgentMetadataV1(input.agent);
	if (capsule.certificateDeliveryRef !== pki.deliveryRef)
		throw new Error("DOMAIN_ROUTE_OWNER_CERTIFICATE_REF_MISMATCH");
	if (capsule.selectedAgentMetadataRef !== agent.readReceiptRef)
		throw new Error("DOMAIN_ROUTE_OWNER_AGENT_REF_MISMATCH");
	if (capsule.agentIds[0] !== agent.agentId) throw new Error("DOMAIN_ROUTE_OWNER_AGENT_ID_MISMATCH");
	return {
		schemaVersion: 1,
		kind: "ack-domain-route-owner-validation",
		status: "passed",
		sourceSha: capsule.sourceSha,
		origin: capsule.origin,
		path: capsule.path,
		pki: { deliveryRef: pki.deliveryRef, issuerType: pki.issuerType },
		capsule: { status: capsule.status, freshCas: true },
		agent: { managementStatus: agent.managementStatus, serviceAvailability: agent.serviceAvailability },
		businessVerified: false,
	};
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	try {
		const [bundleFile, expectedSourceSha, expectedCasFile] = process.argv.slice(2);
		assert(bundleFile && expectedSourceSha && expectedCasFile);
		const bundle = JSON.parse(await readFile(bundleFile, "utf8"));
		const expectedCas = JSON.parse(await readFile(expectedCasFile, "utf8"));
		console.log(JSON.stringify(validateDomainRouteOwnerInputBundleV1(bundle, expectedSourceSha, expectedCas)));
	} catch (error) {
		console.error(error instanceof Error ? error.message : "DOMAIN_ROUTE_OWNER_INPUT_INVALID");
		process.exitCode = 1;
	}
}
