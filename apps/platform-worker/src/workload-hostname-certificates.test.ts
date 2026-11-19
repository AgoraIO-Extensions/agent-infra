import { validateAgentWorkloadDesiredV1 } from "@agent-infra/contracts/workload";
import type { KubernetesObject } from "@kubernetes/client-node";
import { describe, expect, it } from "vitest";
import {
	workloadDesiredFixture,
	workloadTestPolicy,
} from "./kubernetes.fixture.js";
import { fixture } from "./kubernetes-runtime-adapter.fixture.js";
import { createKubernetesRuntimeAdapterV1 } from "./kubernetes-runtime-adapter.js";
import { createWorkloadHostnameCertificatesV1 } from "./workload-hostname-certificates.js";
import { workloadInteractionRouteV1 } from "./workload-public-route.js";

const policy = {
	...workloadTestPolicy,
	hostnameRoutes: {
		hostSuffix: "apps.example.test",
		platformOrigin: "https://platform.example.test",
		clusterIssuerName: "letsencrypt-http01-staging",
		agentIds: ["agent-a"],
	},
};
const certificateName = "agent-a51d7389ba2cb760d233154216317fce-tls";
const hostname = "agent-a51d7389ba2cb760d233154216317fce.apps.example.test";

function desired(revision = 1) {
	const input = workloadDesiredFixture(revision);
	return validateAgentWorkloadDesiredV1({
		...input,
		route: {
			...input.route,
			...workloadInteractionRouteV1(policy, input.agentId),
		},
	});
}

function seedCertificateSecret(
	f: ReturnType<typeof fixture>,
	certificate: KubernetesObject,
) {
	f.seed({
		apiVersion: "v1",
		kind: "Secret",
		metadata: {
			namespace: "workload-test",
			name: certificateName,
			uid: "cert-manager-secret",
			resourceVersion: "1",
			ownerReferences: [
				{
					apiVersion: "cert-manager.io/v1",
					kind: "Certificate",
					name: certificateName,
					uid: certificate.metadata?.uid ?? "invalid-fixture",
				},
			],
		},
	});
}

describe("Agent hostname certificate lifecycle", () => {
	it("does not create a Certificate over an existing foreign Secret", async () => {
		const f = fixture();
		const secret: KubernetesObject = {
			apiVersion: "v1",
			kind: "Secret",
			metadata: {
				namespace: "workload-test",
				name: certificateName,
				uid: "foreign-secret",
				resourceVersion: "3",
			},
		};
		f.seed(secret);
		const adapter = createKubernetesRuntimeAdapterV1({
			client: f.client,
			policy,
			probe: f.probe,
		});
		await expect(adapter.apply(desired())).rejects.toThrow();
		expect(f.writes).toHaveLength(0);
		expect(await f.client.read("Certificate", certificateName)).toBeNull();
		expect(await f.client.read("Secret", certificateName)).toEqual(secret);
	});
	it.each(["foreign-owner", "deleting", "missing-uid"] as const)(
		"rejects a matching Certificate with conflicting existing Secret metadata before writes: %s",
		async (change) => {
			const f = fixture();
			const input = desired();
			const certificates = createWorkloadHostnameCertificatesV1({
				client: f.client,
				policy,
			});
			await certificates.prepare(input);
			const certificate = await f.client.read("Certificate", certificateName);
			if (!certificate) throw new Error("Expected Certificate");
			seedCertificateSecret(f, certificate);
			const secret = await f.client.read("Secret", certificateName);
			if (!secret) throw new Error("Expected Secret");
			f.seed({
				...secret,
				metadata: {
					...secret.metadata,
					...(change === "foreign-owner"
						? {
								ownerReferences: [
									{
										apiVersion: "cert-manager.io/v1",
										kind: "Certificate",
										name: certificateName,
										uid: "other-certificate-uid",
									},
								],
							}
						: change === "deleting"
							? { deletionTimestamp: new Date("2026-01-01T00:00:00Z") }
							: { uid: undefined }),
				},
			});
			const before = structuredClone([...f.resources.entries()]);
			f.writes.length = 0;
			const adapter = createKubernetesRuntimeAdapterV1({
				client: f.client,
				policy,
				probe: f.probe,
			});
			await expect(adapter.apply(input)).rejects.toThrow();
			expect(f.writes).toHaveLength(0);
			expect([...f.resources.entries()]).toEqual(before);
		},
	);
	it("rejects failed metadata reads for an existing Certificate without full-Secret fallback", async () => {
		const f = fixture();
		await createWorkloadHostnameCertificatesV1({
			client: f.client,
			policy,
		}).prepare(desired());
		f.writes.length = 0;
		let fullSecretReads = 0;
		const client: typeof f.client = {
			...f.client,
			async read(kind, name) {
				if (kind === "Secret") fullSecretReads++;
				return f.client.read(kind, name);
			},
			async readMetadata() {
				throw new Error("METADATA_READER_UNAVAILABLE");
			},
		};
		const adapter = createKubernetesRuntimeAdapterV1({
			client,
			policy,
			probe: f.probe,
		});
		await expect(adapter.apply(desired())).rejects.toThrow(
			"METADATA_READER_UNAVAILABLE",
		);
		expect(fullSecretReads).toBe(0);
		expect(f.writes).toHaveLength(0);
	});
	it("keeps an existing Certificate without a Secret as pending controller output", async () => {
		const f = fixture();
		const certificates = createWorkloadHostnameCertificatesV1({
			client: f.client,
			policy,
		});
		await certificates.prepare(desired());
		const before = structuredClone([...f.resources.entries()]);
		f.writes.length = 0;
		await expect(certificates.preflight(desired())).resolves.toBeUndefined();
		await expect(certificates.prepare(desired())).resolves.toBeUndefined();
		expect(await certificates.ready(desired())).toBe(false);
		expect(f.writes).toHaveLength(0);
		expect([...f.resources.entries()]).toEqual(before);
	});
	it("rejects a Secret created between preflight and prepare before any workload write", async () => {
		const f = fixture();
		let reads = 0;
		const client: typeof f.client = {
			...f.client,
			async read(kind, name) {
				if (kind === "Certificate" && ++reads === 2)
					f.seed({
						apiVersion: "v1",
						kind: "Secret",
						metadata: {
							namespace: "workload-test",
							name: certificateName,
							uid: "foreign-secret",
							resourceVersion: "3",
						},
					});
				return f.client.read(kind, name);
			},
		};
		const adapter = createKubernetesRuntimeAdapterV1({
			client,
			policy,
			probe: f.probe,
		});
		await expect(adapter.apply(desired())).rejects.toThrow();
		expect(reads).toBe(2);
		expect(f.writes).toHaveLength(0);
		expect([...f.resources.keys()]).toEqual([`Secret/${certificateName}`]);
	});
	it("does not trust stale Ready when the TLS Secret is absent", async () => {
		const f = fixture();
		const adapter = createKubernetesRuntimeAdapterV1({
			client: f.client,
			policy,
			probe: f.probe,
		});
		const input = desired();
		const identity = await adapter.apply(input);
		if (!identity || identity === "pending")
			throw new Error("Expected workload");
		const certificate = await f.client.read("Certificate", certificateName);
		if (!certificate) throw new Error("Expected Certificate");
		f.seed({
			...certificate,
			status: {
				conditions: [
					{
						type: "Ready",
						status: "True",
						observedGeneration: certificate.metadata?.generation,
					},
				],
				notAfter: "2030-01-01T00:00:00Z",
			},
		} as KubernetesObject);
		expect(await adapter.observe(input, identity)).toBe("certificate-invalid");
		await expect(adapter.promote(input, identity)).rejects.toThrow();
	});
	it.each([{ usages: [] }, { usages: ["client auth"] }])(
		"rejects a Ready certificate whose explicit usages cannot serve HTTPS: %o",
		async ({ usages }) => {
			const f = fixture();
			const adapter = createKubernetesRuntimeAdapterV1({
				client: f.client,
				policy,
				probe: f.probe,
			});
			const input = desired();
			const identity = await adapter.apply(input);
			if (!identity || identity === "pending")
				throw new Error("Expected workload");
			const certificate = await f.client.read("Certificate", certificateName);
			if (!certificate) throw new Error("Expected Certificate");
			const unusable = {
				...certificate,
				spec: { ...(certificate as { spec: object }).spec, usages },
				status: {
					conditions: [
						{
							type: "Ready",
							status: "True",
							observedGeneration: certificate.metadata?.generation,
						},
					],
					notAfter: "2030-01-01T00:00:00Z",
				},
			} as KubernetesObject;
			f.seed(unusable);
			seedCertificateSecret(f, certificate);
			expect(await adapter.observe(input, identity)).toBe(
				"certificate-invalid",
			);
			await expect(adapter.promote(input, identity)).rejects.toThrow();
			await expect(adapter.apply(input)).rejects.toThrow();
			expect(await f.client.read("Ingress", input.service.name)).toBeNull();
			expect(await f.client.read("Certificate", certificateName)).toEqual(
				unusable,
			);
		},
	);
	it.each([{ usages: undefined }, { usages: ["server auth"] }])(
		"reuses matching default or explicit HTTPS server usages: %o",
		async ({ usages }) => {
			const f = fixture();
			const adapter = createKubernetesRuntimeAdapterV1({
				client: f.client,
				policy,
				probe: f.probe,
			});
			const input = desired();
			await adapter.apply(input);
			const certificate = await f.client.read("Certificate", certificateName);
			if (!certificate) throw new Error("Expected Certificate");
			const existing = {
				...certificate,
				spec: { ...(certificate as { spec: object }).spec, usages },
				status: {
					conditions: [
						{
							type: "Ready",
							status: "True",
							observedGeneration: certificate.metadata?.generation,
						},
					],
					notAfter: "2030-01-01T00:00:00Z",
				},
			} as KubernetesObject;
			f.seed(existing);
			seedCertificateSecret(f, certificate);
			const identity = await adapter.apply(input);
			if (!identity || identity === "pending")
				throw new Error("Expected workload");
			expect(await adapter.observe(input, identity)).toBe("healthy");
			await adapter.promote(input, identity);
			expect(await f.client.read("Certificate", certificateName)).toEqual(
				existing,
			);
		},
	);
	it("reuses the same certificate and Secret across stop, restart and revision change", async () => {
		const f = fixture();
		const adapter = createKubernetesRuntimeAdapterV1({
			client: f.client,
			policy,
			probe: f.probe,
		});
		const input = desired();
		const first = await adapter.apply(input);
		if (!first || first === "pending") throw new Error("Expected workload");
		const certificate = await f.client.read("Certificate", certificateName);
		if (!certificate) throw new Error("Expected Certificate");
		f.seed({
			...certificate,
			status: {
				conditions: [
					{
						type: "Ready",
						status: "True",
						observedGeneration: certificate.metadata?.generation,
					},
				],
				notAfter: "2030-01-01T00:00:00Z",
			},
		} as KubernetesObject);
		const secret: KubernetesObject = {
			apiVersion: "v1",
			kind: "Secret",
			metadata: {
				name: certificateName,
				namespace: "workload-test",
				uid: "cert-manager-secret",
				resourceVersion: "1",
			},
		};
		f.seed(secret);
		const before = await f.client.read("Certificate", certificateName);
		await adapter.promote(input, first);
		await adapter.cleanupAgent(
			input.agentId,
			input.workloadRevision,
			input.fence,
			false,
		);
		expect(await f.client.read("Ingress", input.service.name)).toBeNull();
		expect(await f.client.read("Certificate", certificateName)).toEqual(before);
		expect(await f.client.read("Secret", certificateName)).toEqual(secret);
		const next = desired(2);
		const second = await adapter.apply(next);
		if (!second || second === "pending")
			throw new Error("Expected restarted workload");
		await adapter.promote(next, second);
		expect(await f.client.read("Certificate", certificateName)).toEqual(before);
		expect(await f.client.read("Secret", certificateName)).toEqual(secret);
	});
	it.each([
		{
			conditions: [{ type: "Ready", status: "True", observedGeneration: 0 }],
			notAfter: "2030-01-01T00:00:00Z",
		},
		{
			conditions: [{ type: "Ready", status: "False", observedGeneration: 1 }],
			notAfter: "2030-01-01T00:00:00Z",
		},
		{
			conditions: [{ type: "Ready", status: "True", observedGeneration: 1 }],
			notAfter: "2000-01-01T00:00:00Z",
		},
	])("refuses stale or expired certificate status: %o", async (status) => {
		const f = fixture();
		const adapter = createKubernetesRuntimeAdapterV1({
			client: f.client,
			policy,
			probe: f.probe,
		});
		const input = desired();
		const identity = await adapter.apply(input);
		if (!identity || identity === "pending")
			throw new Error("Expected workload");
		const certificate = await f.client.read("Certificate", certificateName);
		if (!certificate) throw new Error("Expected Certificate");
		f.seed({ ...certificate, status } as KubernetesObject);
		seedCertificateSecret(f, certificate);
		expect(await adapter.observe(input, identity)).toBe("certificate-invalid");
		await expect(adapter.promote(input, identity)).rejects.toThrow();
		expect(await f.client.read("Ingress", input.service.name)).toBeNull();
	});
	it.each([
		{ annotations: { "agent-infra.agora.io/agent-id": "another-agent" } },
		{ labels: { "agent-infra.agora.io/agent": "another-agent" } },
		{
			ownerReferences: [
				{
					apiVersion: "networking.k8s.io/v1",
					kind: "Ingress",
					name: "old-route",
					uid: "ephemeral-ingress",
				},
			],
		},
	])(
		"does not adopt foreign or Ingress-owned certificate metadata: %o",
		async (change) => {
			const f = fixture();
			const existing: KubernetesObject = {
				apiVersion: "cert-manager.io/v1",
				kind: "Certificate",
				metadata: {
					namespace: "workload-test",
					name: certificateName,
					uid: "original-certificate",
					resourceVersion: "3",
					generation: 1,
					...change,
				},
				spec: {
					dnsNames: [hostname],
					secretName: certificateName,
					issuerRef: {
						group: "cert-manager.io",
						kind: "ClusterIssuer",
						name: "letsencrypt-http01-staging",
					},
				},
			} as KubernetesObject;
			f.seed(existing);
			const adapter = createKubernetesRuntimeAdapterV1({
				client: f.client,
				policy,
				probe: f.probe,
			});
			await expect(adapter.apply(desired())).rejects.toThrow();
			expect(await f.client.read("Certificate", certificateName)).toEqual(
				existing,
			);
		},
	);
	it("does not consider a not-yet-valid Certificate usable", async () => {
		const f = fixture();
		const adapter = createKubernetesRuntimeAdapterV1({
			client: f.client,
			policy,
			probe: f.probe,
		});
		const input = desired();
		const identity = await adapter.apply(input);
		if (!identity || identity === "pending")
			throw new Error("Expected workload");
		const certificate = await f.client.read("Certificate", certificateName);
		if (!certificate) throw new Error("Expected Certificate");
		f.seed({
			...certificate,
			status: {
				conditions: [
					{
						type: "Ready",
						status: "True",
						observedGeneration: certificate.metadata?.generation,
					},
				],
				notBefore: "2099-01-01T00:00:00Z",
				notAfter: "2099-02-01T00:00:00Z",
			},
		} as KubernetesObject);
		seedCertificateSecret(f, certificate);
		expect(await adapter.observe(input, identity)).toBe("certificate-invalid");
		await expect(adapter.promote(input, identity)).rejects.toThrow();
	});
	it("keeps the route closed until the current exact Certificate is ready", async () => {
		const f = fixture();
		const adapter = createKubernetesRuntimeAdapterV1({
			client: f.client,
			policy,
			probe: f.probe,
		});
		const input = desired();
		const identity = await adapter.apply(input);
		if (!identity || identity === "pending")
			throw new Error("Expected workload");
		const certificate = await f.client.read("Certificate", certificateName);
		if (!certificate) throw new Error("Expected Certificate");
		f.seed({
			...certificate,
			metadata: {
				...certificate.metadata,
				creationTimestamp: new Date(Date.now()),
			},
		});
		expect(await adapter.observe(input, identity)).toBe("certificate-pending");
		await expect(adapter.promote(input, identity)).rejects.toThrow();
		expect(await f.client.read("Ingress", input.service.name)).toBeNull();
		f.seed({
			...certificate,
			status: {
				conditions: [
					{
						type: "Ready",
						status: "True",
						observedGeneration: certificate.metadata?.generation,
					},
				],
				notAfter: "2030-01-01T00:00:00Z",
			},
		} as KubernetesObject);
		seedCertificateSecret(f, certificate);
		expect(await adapter.observe(input, identity)).toBe("healthy");
		await adapter.promote(input, identity);
		expect(await f.client.read("Ingress", input.service.name)).toMatchObject({
			spec: {
				tls: [{ hosts: [hostname], secretName: certificateName }],
				rules: [{ host: hostname, http: { paths: [{ path: "/" }] } }],
			},
		});
	});
	it.each([
		{ issuerRef: { kind: "Issuer", name: "foreign" } },
		{ secretName: "foreign-secret" },
		{ dnsNames: [hostname, "foreign.apps.example.test"] },
		{ commonName: "*.apps.example.test" },
		{ ipAddresses: ["192.0.2.1"] },
		{ uris: ["spiffe://foreign.example.test/identity"] },
		{ emailAddresses: ["foreign@example.test"] },
		{ isCA: true },
	])(
		"never overwrites a conflicting pre-existing Certificate: %o",
		async (change) => {
			const f = fixture();
			const existing: KubernetesObject = {
				apiVersion: "cert-manager.io/v1",
				kind: "Certificate",
				metadata: {
					namespace: "workload-test",
					name: certificateName,
					uid: "original-certificate",
					resourceVersion: "3",
					generation: 1,
				},
				spec: {
					dnsNames: [hostname],
					secretName: certificateName,
					issuerRef: {
						group: "cert-manager.io",
						kind: "ClusterIssuer",
						name: "letsencrypt-http01-staging",
					},
					...change,
				},
			} as KubernetesObject;
			f.seed(existing);
			const adapter = createKubernetesRuntimeAdapterV1({
				client: f.client,
				policy,
				probe: f.probe,
			});
			await expect(adapter.apply(desired())).rejects.toThrow();
			expect(await f.client.read("Certificate", certificateName)).toEqual(
				existing,
			);
		},
	);
	it("prepares one exact Certificate independently of the unpromoted Ingress", async () => {
		const f = fixture();
		const adapter = createKubernetesRuntimeAdapterV1({
			client: f.client,
			policy,
			probe: f.probe,
		});
		const input = desired();
		await adapter.apply(input);
		const certificate = await f.client.read("Certificate", certificateName);
		expect(certificate).toMatchObject({
			apiVersion: "cert-manager.io/v1",
			kind: "Certificate",
			metadata: { name: certificateName, namespace: "workload-test" },
			spec: {
				dnsNames: [hostname],
				secretName: certificateName,
				issuerRef: {
					group: "cert-manager.io",
					kind: "ClusterIssuer",
					name: "letsencrypt-http01-staging",
				},
			},
		});
		expect(certificate?.metadata?.ownerReferences).toBeUndefined();
		expect(await f.client.read("Ingress", input.service.name)).toBeNull();
		expect(await f.client.read("Secret", certificateName)).toBeNull();
	});
});
