import { createHash } from "node:crypto";

const b64 = (text) => Buffer.from(text, "utf8").toString("base64");

const access = {
	publicOrigin: "https://connector.example.invalid",
	mcpPath: "/mcp",
	audience: "https://connector.example.invalid/mcp",
	issuer: "https://connector.example.invalid/",
	oauthCallbackUrl:
		"https://platform.example.invalid/api/connection-installations/callback",
	egressProfile: { ref: "fixture:egress", revision: "fixture-revision" },
};
const fingerprint = createHash("sha256")
	.update(
		JSON.stringify([
			"connection-system-access/v1",
			access.publicOrigin,
			access.mcpPath,
			access.audience,
			access.egressProfile.ref,
			access.egressProfile.revision,
			access.issuer,
			access.oauthCallbackUrl,
		]),
	)
	.digest("hex");
const source = { ref: "fixture-approval", revision: "1" };
const marker = "fixture-release-do-not-print";

export function productionChartValues({
	api = "export const fixture = 1;\n",
	worker = "export const fixture = 1;\n",
	manual = {},
	platformApi = {},
} = {}) {
	return {
		configuration: {
			enabled: true,
			api: { "configuration.mjs": b64(api) },
			worker: { "configuration.mjs": b64(worker) },
		},
		platformApi: {
			connectionWebPath: "/connection/connections",
			connectionCallbackAuthSecretRef: {
				name: "fixture-callback-auth",
				key: "callback.auth",
			},
			connectionSystemAccess: {
				enabled: true,
				...access,
				approval: {
					configFingerprint: fingerprint,
					egressEnforced: true,
					source,
				},
			},
			...platformApi,
		},
		connectionManualInstallation: {
			enabled: true,
			exceptionApproval: {
				schemaVersion: 1,
				kind: "consistency-exception-v1",
				policy: { ref: "consistency-exception-v1", revision: "1" },
				notAfter: "2000-01-01T00:00:00Z",
				maximumPinnedPrincipals: 2,
				verificationWindowHours: 24,
				connectionRelease: marker,
				systemAccessFingerprint: fingerprint,
				approvalSource: source,
			},
			clientName: "Fixture Client",
			hostCaSecretRef: { name: "fixture-host-ca", key: "ca.crt" },
			readbackTlsSecretRef: {
				name: "fixture-readback-tls",
				certKey: "tls.crt",
				keyKey: "tls.key",
			},
			hostTlsSecretRef: {
				name: "fixture-host-tls",
				certKey: "tls.crt",
				keyKey: "tls.key",
			},
			workerCaSecretRef: { name: "fixture-worker-ca", key: "ca.crt" },
			...manual,
		},
	};
}
