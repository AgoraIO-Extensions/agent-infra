import { describe, expect, it } from "vitest";
import {
	connectionSystemAccessFingerprintV1,
	resolveApprovedConnectionSystemAccessV1,
} from "../connection-consumer-profile.ts";
import {
	buildConnectionRegistrationTemplateV1,
	connectionManualInstallConfigurationV1,
	connectionManualInstallDescriptorDigestV1,
	connectionManualInstallDescriptorMatchesV1,
	connectionManualInstallDescriptorV1,
	resolveConnectionManualDynamicApprovalV1,
} from "./connection-install-node.ts";

const system = {
	schemaVersion: 1 as const,
	publicOrigin: "https://connection.test",
	mcpPath: "/mcp",
	audience: "mcp",
	egressProfile: { ref: "egress", revision: "r1" },
	issuer: "https://connection.test/",
	oauthCallbackUrl: "https://platform.test/connection/callback",
};
const source = { ref: "platform-deployment", revision: "r1" };
const resolved = resolveApprovedConnectionSystemAccessV1(system, {
	schemaVersion: 1,
	configFingerprint: connectionSystemAccessFingerprintV1(system),
	egressEnforced: true,
	source,
});
if (resolved.status !== "available") throw new Error("fixture");
const access = resolved;

const exception = {
	schemaVersion: 1,
	kind: "consistency-exception-v1",
	policy: { ref: "consistency-exception-v1", revision: "r1" },
	notAfter: "2099-01-01T00:00:00Z",
	maximumPinnedPrincipals: 2,
	verificationWindowHours: 24,
	connectionRelease: "agora-connector-2019ca07",
	systemAccessFingerprint: access.configFingerprint,
	approvalSource: source,
};
const mapping = {
	schemaVersion: 1,
	kind: "principal_mapping",
	authority: { ref: "corp-identity", revision: "r1" },
	rule: { ref: "ldap-uid-to-connection-subject", revision: "r1" },
	issuer: system.issuer,
	resolution: { ref: "identity-adapter-ldap", revision: "r1" },
	systemAccessFingerprint: access.configFingerprint,
	approvalSource: source,
};
const approval = (principalMapping: unknown = exception) => ({
	schemaVersion: 1,
	principalMapping,
	readbackContract: { ref: "connection-ep-1060-read", revision: "1" },
	publicationContract: { ref: "connection-mcp-publication", revision: "1" },
});

describe("§13.5.1 dynamic manual approvals", () => {
	it("accepts an exception or a mapping bound to the same system access and source", () => {
		expect(
			resolveConnectionManualDynamicApprovalV1(approval(), access)
				.principalMapping,
		).toEqual(exception);
		expect(
			resolveConnectionManualDynamicApprovalV1(approval(mapping), access)
				.principalMapping,
		).toEqual(mapping);
	});

	it.each([
		["another system access", { systemAccessFingerprint: "a".repeat(64) }],
		[
			"another approval source revision",
			{ approvalSource: { ...source, revision: "r2" } },
		],
		["a verification window over 24 hours", { verificationWindowHours: 25 }],
		["no verification window", { verificationWindowHours: 0 }],
		["no pin capacity", { maximumPinnedPrincipals: 0 }],
		["a non-UTC notAfter", { notAfter: "2099-01-01T08:00:00+08:00" }],
		["an invalid notAfter", { notAfter: "2099-13-01T00:00:00Z" }],
		["no Connection release", { connectionRelease: "" }],
		["an unknown field", { extra: true }],
	])("refuses an exception with %s", (_name, change) => {
		expect(() =>
			resolveConnectionManualDynamicApprovalV1(
				approval({ ...exception, ...change }),
				access,
			),
		).toThrow("CONNECTION_MANUAL_DYNAMIC_APPROVAL_INVALID");
	});

	it.each([
		"policy",
		"notAfter",
		"maximumPinnedPrincipals",
		"verificationWindowHours",
		"connectionRelease",
		"systemAccessFingerprint",
		"approvalSource",
	])("refuses an exception without %s", (field) => {
		const { [field as keyof typeof exception]: _omitted, ...partial } =
			exception;
		expect(() =>
			resolveConnectionManualDynamicApprovalV1(approval(partial), access),
		).toThrow("CONNECTION_MANUAL_DYNAMIC_APPROVAL_INVALID");
	});

	it("refuses a mapping for another issuer and an approval without contracts", () => {
		expect(() =>
			resolveConnectionManualDynamicApprovalV1(
				approval({ ...mapping, issuer: "https://other.test/" }),
				access,
			),
		).toThrow("CONNECTION_MANUAL_DYNAMIC_APPROVAL_INVALID");
		const { publicationContract: _publication, ...withoutPublication } =
			approval();
		expect(() =>
			resolveConnectionManualDynamicApprovalV1(withoutPublication, access),
		).toThrow("CONNECTION_MANUAL_DYNAMIC_APPROVAL_INVALID");
	});
});

describe("§13.5.6 dynamic manual descriptor", () => {
	const template = buildConnectionRegistrationTemplateV1({
		access,
		clientName: "Agent Infra",
		principal: { kind: "user", id: "alice" },
		reference: {
			agentId: "agent-a",
			conversationId: "conversation-a",
			executionId: "execution-a",
			sessionGeneration: 1,
		},
		authorizationId: "authorization-a",
		confirmationRevision: "confirmation-a",
		expiresAt: Date.now() + 600_000,
		association: { connectionAgentId: "connection-agent-a", revision: 1 },
		claim: { owner: "worker-a", fence: 3 },
		target: {
			deploymentIdentity: "session-sandbox-v1/sandboxes/worker-a",
			hostRef: "host-a",
			sandboxId: "sandbox-a",
			podUid: "pod-a",
			sessionGeneration: 1,
			resourceFence: 1,
			runtimeOrigin: "https://sandbox-a.sandboxes.svc:3443/",
		},
		registrationKey: "mi-registration-key-a",
	});
	const receipt = {
		registrationKey: "mi-registration-key-a",
		clientId: "client-a",
		clientName: template.registration.clientName,
		clientStatus: "ACTIVE",
		configFingerprint: template.registration.configFingerprint,
		consumerId: "consumer-a",
		createdAt: "2026-11-20T00:00:00.000Z",
		instanceId: "instance-a",
		instanceStatus: "ACTIVE",
		principalId: null,
		redirectUri: template.registration.redirectUri,
		resource: template.registration.resource,
		scope: "mcp",
		source: template.registration.source,
		status: "ACTIVE",
	};
	const configuration = connectionManualInstallConfigurationV1({
		access,
		template,
		receipt,
	});
	const resolvedApproval = resolveConnectionManualDynamicApprovalV1(
		approval(),
		access,
	);

	it("names this receipt, configuration, supply and the exception policy", () => {
		const descriptor = connectionManualInstallDescriptorV1({
			approval: resolvedApproval,
			template,
			receipt,
			configuration,
			pinnedPrincipalId: null,
		});
		expect(descriptor).toMatchObject({
			registrationKey: receipt.registrationKey,
			consumerId: "consumer-a",
			clientId: "client-a",
			instanceId: "instance-a",
			configuration: {
				ref: configuration.ref,
				revision: configuration.revision,
			},
			principalMapping: {
				kind: "consistency-exception-v1",
				policy: exception.policy,
				pinnedPrincipalId: null,
			},
			supply: template.supply,
		});
		expect(
			connectionManualInstallDescriptorMatchesV1(descriptor, {
				template,
				receipt,
				configuration,
			}),
		).toBe(true);
		// Another installation's client, instance, configuration or supply never matches.
		for (const replaced of [
			{ clientId: "client-b" },
			{ instanceId: "instance-b" },
			{ consumerId: "consumer-b" },
			{ registrationKey: "mi-registration-key-b" },
			{ configuration: { ...descriptor.configuration, revision: "r-other" } },
			{ supply: { ...descriptor.supply, revision: "2" } },
		])
			expect(
				connectionManualInstallDescriptorMatchesV1(
					{ ...descriptor, ...replaced },
					{ template, receipt, configuration },
				),
			).toBe(false);
		expect(
			connectionManualInstallDescriptorDigestV1({
				...descriptor,
				principalMapping: {
					kind: "consistency-exception-v1",
					policy: exception.policy,
					pinnedPrincipalId: "principal-a",
				},
			}),
		).not.toBe(connectionManualInstallDescriptorDigestV1(descriptor));
	});

	it("produces no descriptor for a mapping rule without a resolver", () => {
		expect(() =>
			connectionManualInstallDescriptorV1({
				approval: resolveConnectionManualDynamicApprovalV1(
					approval(mapping),
					access,
				),
				template,
				receipt,
				configuration,
				pinnedPrincipalId: null,
			}),
		).toThrow("CONNECTION_MANUAL_PRINCIPAL_MAPPING_UNAVAILABLE");
	});
});
