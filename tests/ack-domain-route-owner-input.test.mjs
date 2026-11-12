import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
	validateDomainRouteOwnerInputBundleV1,
	validateDomainRoutePkiInputV1,
} from "../deploy/ack/domain-route-owner-input.ts";

const agentId =
	"agent_api_c54968af289033573b0a25f29a2cae88ff182518286bc7c7b162aad5791b1e4d";
const path = `/a/agent-${createHash("sha256").update(agentId).digest("hex").slice(0, 32)}/`;
const sourceSha = "adbe87dc76fc9d46c55b09c6ca30ce87aaeb4a74";
const pki = () => ({
	schemaVersion: 1,
	kind: "ack-domain-route-pki",
	hostname: "apps.agent-infra.agoralab.co",
	san: "apps.agent-infra.agoralab.co",
	secretName: "agent-infra-apps-tls",
	deliveryRef: "pki-delivery-ref",
	fullchainScope: "leaf+intermediate",
	publicFingerprint: "sha256:fingerprint",
	expiresAt: "2027-02-01T00:00:00Z",
	renewalOwner: "sre-pki",
	renewalMechanism: "external-pki",
	issuerType: "external-pki",
	wildcard: false,
	privateKeyIncluded: false,
});
const capsule = () => ({
	schemaVersion: 1,
	kind: "ack-domain-route-capsule",
	sourceSha,
	origin: "https://apps.agent-infra.agoralab.co",
	platformOrigin: "https://agent-infra.agoralab.co",
	tlsSecretName: "agent-infra-apps-tls",
	agentIds: [agentId],
	path,
	certificateDeliveryRef: "pki-delivery-ref",
	selectedAgentMetadataRef: "agent-read-ref",
	prefixCompatibilityRef: "prefix-ref",
	freshCas: {
		namespaceUid: "namespace-uid",
		releaseRevision: "42",
		workerSecretUid: "secret-uid",
		workerSecretResourceVersion: "secret-rv",
		configurationSha256: "a".repeat(64),
		workerImage: `registry.example/worker@sha256:${"b".repeat(64)}`,
	},
	status: "proposal",
	wildcard: false,
	sameHostSubstitute: false,
	directApply: false,
	postrendererBypass: false,
});
const agent = () => ({
	schemaVersion: 1,
	kind: "ack-domain-route-agent-metadata",
	agentId,
	managementStatus: "available",
	managementRevision: 7,
	serviceAvailability: "ready",
	configurationRevision: 3,
	source: {
		kind: "custom",
		interactionMode: "self-managed",
		identityResponsibility: "self-managed",
	},
	imageReference: `registry.example/app@sha256:${"c".repeat(64)}`,
	interactionUrl: `https://apps.agent-infra.agoralab.co${path}`,
	prefixCompatible: true,
	readReceiptRef: "agent-read-ref",
});
const bundle = () => ({
	schemaVersion: 1,
	kind: "ack-domain-route-owner-input",
	pki: pki(),
	capsule: capsule(),
	agent: agent(),
});
const expectedCas = () => capsule().freshCas;

test("accepts a current exact-host owner bundle", () => {
	const receipt = validateDomainRouteOwnerInputBundleV1(
		bundle(),
		sourceSha,
		expectedCas(),
	);
	assert.equal(receipt.status, "passed");
	assert.equal(receipt.path, path);
	assert.equal(receipt.businessVerified, false);
});

test("rejects stale source, same-host, wildcard, missing renewal and missing CAS", () => {
	assert.throws(
		() =>
			validateDomainRouteOwnerInputBundleV1(
				bundle(),
				"3db2ed2113bd388e95a349be38846a5bc7e9bb93",
				expectedCas(),
			),
		/DOMAIN_ROUTE_CAPSULE_SOURCE/,
	);
	assert.throws(
		() =>
			validateDomainRouteOwnerInputBundleV1(
				{
					...bundle(),
					capsule: { ...capsule(), origin: "https://agent-infra.agoralab.co" },
				},
				sourceSha,
				expectedCas(),
			),
		/DOMAIN_ROUTE_CAPSULE_ORIGIN/,
	);
	assert.throws(
		() =>
			validateDomainRouteOwnerInputBundleV1(
				{ ...bundle(), pki: { ...pki(), wildcard: true } },
				sourceSha,
				expectedCas(),
			),
		/DOMAIN_ROUTE_PKI_WILDCARD/,
	);
	assert.throws(
		() =>
			validateDomainRouteOwnerInputBundleV1(
				{ ...bundle(), pki: { ...pki(), renewalOwner: "" } },
				sourceSha,
				expectedCas(),
			),
		/DOMAIN_ROUTE_PKI_RENEWAL_OWNER/,
	);
	assert.throws(
		() =>
			validateDomainRouteOwnerInputBundleV1(
				{ ...bundle(), capsule: { ...capsule(), freshCas: undefined } },
				sourceSha,
				expectedCas(),
			),
		/DOMAIN_ROUTE_CAPSULE_CAS/,
	);
	assert.throws(
		() =>
			validateDomainRouteOwnerInputBundleV1(
				{
					...bundle(),
					agent: { ...agent(), source: { ...agent().source, extra: true } },
				},
				sourceSha,
				expectedCas(),
			),
		/DOMAIN_ROUTE_AGENT_SOURCE_UNKNOWN_FIELD/,
	);
	assert.throws(
		() =>
			validateDomainRouteOwnerInputBundleV1(
				{
					...bundle(),
					capsule: {
						...capsule(),
						freshCas: { ...capsule().freshCas, extra: true },
					},
				},
				sourceSha,
				expectedCas(),
			),
		/DOMAIN_ROUTE_CAPSULE_CAS_UNKNOWN_FIELD/,
	);
	assert.throws(
		() =>
			validateDomainRouteOwnerInputBundleV1(
				{ ...bundle(), agent: { ...agent(), managementRevision: {} } },
				sourceSha,
				expectedCas(),
			),
		/DOMAIN_ROUTE_AGENT_MANAGEMENT_REVISION/,
	);
	assert.throws(
		() =>
			validateDomainRouteOwnerInputBundleV1(
				{
					...bundle(),
					agent: { ...agent(), source: { ...agent().source, kind: "" } },
				},
				sourceSha,
				expectedCas(),
			),
		/DOMAIN_ROUTE_AGENT_SOURCE_KIND/,
	);
});

test("requires explicit ACME authorization for cert-manager", () => {
	assert.throws(
		() =>
			validateDomainRoutePkiInputV1({
				...pki(),
				issuerType: "cert-manager",
				acmeAuthorizationRef: undefined,
			}),
		/DOMAIN_ROUTE_PKI_ACME_AUTHORIZATION/,
	);
	assert.throws(
		() => validateDomainRoutePkiInputV1({ ...pki(), acmeAuthorizationRef: 7 }),
		/DOMAIN_ROUTE_PKI_ACME_AUTHORIZATION/,
	);
});

test("requires a field window only after capsule acceptance", () => {
	assert.doesNotThrow(() =>
		validateDomainRouteOwnerInputBundleV1(bundle(), sourceSha, expectedCas()),
	);
	assert.throws(
		() =>
			validateDomainRouteOwnerInputBundleV1(
				{ ...bundle(), capsule: { ...capsule(), status: "accepted" } },
				sourceSha,
				expectedCas(),
			),
		/DOMAIN_ROUTE_CAPSULE_FIELD_WINDOW/,
	);
	assert.throws(
		() =>
			validateDomainRouteOwnerInputBundleV1(
				{ ...bundle(), capsule: { ...capsule(), fieldWindowRef: 7 } },
				sourceSha,
				expectedCas(),
			),
		/DOMAIN_ROUTE_CAPSULE_FIELD_WINDOW/,
	);
});

test("schema keeps cert-manager and accepted-capsule gates conditional", async () => {
	const schema = JSON.parse(
		await readFile(
			new URL(
				"../deploy/ack/domain-route-owner-input.schema.json",
				import.meta.url,
			),
			"utf8",
		),
	);
	assert.deepEqual(schema.$defs.pki.allOf[0].if, {
		properties: { issuerType: { const: "cert-manager" } },
	});
	assert.deepEqual(schema.$defs.pki.allOf[0].then, {
		required: ["acmeAuthorizationRef"],
	});
	assert.deepEqual(schema.$defs.capsule.allOf[0].if, {
		properties: { status: { const: "accepted" } },
	});
	assert.deepEqual(schema.$defs.capsule.allOf[0].then, {
		required: ["fieldWindowRef"],
	});
	assert.equal(
		schema.$defs.agent.properties.configurationRevision.maximum,
		Number.MAX_SAFE_INTEGER,
	);
});

test("rejects an invalid expected source hash before capsule comparison", () => {
	assert.throws(
		() => validateDomainRouteOwnerInputBundleV1(bundle(), "", expectedCas()),
		/DOMAIN_ROUTE_CAPSULE_EXPECTED_SOURCE/,
	);
});

test("rejects stale CAS even when bundle shape is valid", () => {
	assert.throws(
		() =>
			validateDomainRouteOwnerInputBundleV1(bundle(), sourceSha, {
				...expectedCas(),
				releaseRevision: "stale",
			}),
		/DOMAIN_ROUTE_CAPSULE_CAS_MISMATCH/,
	);
});

test("rejects interaction URLs that escape or encode the selected path", () => {
	for (const interactionUrl of [
		`https://apps.agent-infra.agoralab.co${path}../other`,
		`https://apps.agent-infra.agoralab.co${path}nested/../other`,
		`https://apps.agent-infra.agoralab.co${path}%2e%2e/other`,
	]) {
		assert.throws(
			() =>
				validateDomainRouteOwnerInputBundleV1(
					{ ...bundle(), agent: { ...agent(), interactionUrl } },
					sourceSha,
					expectedCas(),
				),
			/DOMAIN_ROUTE_AGENT_INTERACTION_URL/,
		);
	}
});
