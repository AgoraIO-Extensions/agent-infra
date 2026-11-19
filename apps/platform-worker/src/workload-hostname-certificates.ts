import type { AgentWorkloadDesiredV1 } from "@agent-infra/contracts/workload";
import { WorkloadPreflightRejectedErrorV1 } from "@agent-infra/platform-core";
import type { KubernetesObject } from "@kubernetes/client-node";
import type { WorkerKubernetesClientV1 } from "./kubernetes-client.js";
import {
	agentAnnotation,
	ownerLabel,
	workloadResourceNameV1,
} from "./kubernetes-runtime-comparison.js";
import {
	type WorkloadPublicRoutePolicyV1,
	workloadPublicRouteV1,
} from "./workload-public-route.js";

export interface WorkloadHostnameCertificateV1 extends KubernetesObject {
	readonly spec?: {
		readonly commonName?: string;
		readonly dnsNames?: readonly string[];
		readonly ipAddresses?: readonly string[];
		readonly uris?: readonly string[];
		readonly emailAddresses?: readonly string[];
		readonly isCA?: boolean;
		readonly usages?: readonly string[];
		readonly secretName?: string;
		readonly issuerRef?: {
			readonly group?: string;
			readonly kind?: string;
			readonly name?: string;
		};
	};
	readonly status?: {
		readonly lastFailureTime?: string;
		readonly notBefore?: string;
		readonly notAfter?: string;
		readonly conditions?: readonly {
			readonly type?: string;
			readonly status?: string;
			readonly observedGeneration?: number;
		}[];
	};
}

function matchesCertificate(
	object: WorkloadHostnameCertificateV1,
	input: {
		readonly namespace: string;
		readonly name: string;
		readonly host: string;
		readonly issuerName: string;
		readonly agentId: string;
	},
) {
	return (
		object.apiVersion === "cert-manager.io/v1" &&
		object.kind === "Certificate" &&
		object.metadata?.namespace === input.namespace &&
		object.metadata.name === input.name &&
		!object.metadata.deletionTimestamp &&
		(object.metadata.ownerReferences?.length ?? 0) === 0 &&
		(object.metadata.annotations?.[agentAnnotation] === undefined ||
			object.metadata.annotations[agentAnnotation] === input.agentId) &&
		(object.metadata.labels?.[ownerLabel] === undefined ||
			object.metadata.labels[ownerLabel] ===
				workloadResourceNameV1(input.agentId)) &&
		object.spec?.secretName === input.name &&
		Array.isArray(object.spec.dnsNames) &&
		object.spec.dnsNames.length === 1 &&
		object.spec.dnsNames[0] === input.host &&
		(object.spec.commonName === undefined ||
			object.spec.commonName === input.host) &&
		(object.spec.ipAddresses === undefined ||
			object.spec.ipAddresses.length === 0) &&
		(object.spec.uris === undefined || object.spec.uris.length === 0) &&
		(object.spec.emailAddresses === undefined ||
			object.spec.emailAddresses.length === 0) &&
		object.spec.isCA !== true &&
		(object.spec.usages === undefined ||
			(Array.isArray(object.spec.usages) &&
				object.spec.usages.includes("server auth"))) &&
		object.spec.issuerRef?.kind === "ClusterIssuer" &&
		(object.spec.issuerRef.group === undefined ||
			object.spec.issuerRef.group === "cert-manager.io") &&
		object.spec.issuerRef.name === input.issuerName
	);
}

function matchesSecretMetadata(
	secret: Pick<KubernetesObject, "metadata">,
	certificate: WorkloadHostnameCertificateV1,
	namespace: string,
	name: string,
) {
	const metadata = secret.metadata;
	if (
		!metadata ||
		typeof metadata.uid !== "string" ||
		!metadata.uid ||
		typeof metadata.resourceVersion !== "string" ||
		!metadata.resourceVersion ||
		metadata.deletionTimestamp ||
		metadata.namespace !== namespace ||
		metadata.name !== name
	)
		return false;
	const owners = metadata.ownerReferences ?? [];
	return (
		owners.length === 0 ||
		(owners.length === 1 &&
			owners[0]?.apiVersion === "cert-manager.io/v1" &&
			owners[0].kind === "Certificate" &&
			owners[0].name === name &&
			typeof certificate.metadata?.uid === "string" &&
			owners[0].uid === certificate.metadata.uid)
	);
}

// Bound first issuance across Worker restarts using the Certificate's API-server timestamp.
const maximumIssuanceWaitMs = 4 * 60 * 60_000;

/** Stable declarations; cert-manager exclusively owns issuance and Secret contents. */
export function createWorkloadHostnameCertificatesV1(options: {
	readonly client: WorkerKubernetesClientV1;
	readonly policy: WorkloadPublicRoutePolicyV1;
}) {
	async function preparation(
		value: Pick<AgentWorkloadDesiredV1, "agentId" | "replicas">,
	) {
		const selected = options.policy.hostnameRoutes;
		if (!selected?.agentIds.includes(value.agentId) || value.replicas === 0)
			return;
		const route = workloadPublicRouteV1(options.policy, value.agentId);
		const current = await options.client.read<WorkloadHostnameCertificateV1>(
			"Certificate",
			route.tlsSecretName,
		);
		if (current) {
			if (
				!matchesCertificate(current, {
					namespace: options.client.namespace,
					name: route.tlsSecretName,
					host: route.host,
					issuerName: selected.clusterIssuerName,
					agentId: value.agentId,
				})
			)
				throw new WorkloadPreflightRejectedErrorV1("desired-workload");
			if (!options.client.readMetadata)
				throw new WorkloadPreflightRejectedErrorV1("desired-workload");
			const secret = await options.client.readMetadata(
				"Secret",
				route.tlsSecretName,
			);
			if (
				secret &&
				!matchesSecretMetadata(
					secret,
					current,
					options.client.namespace,
					route.tlsSecretName,
				)
			)
				throw new WorkloadPreflightRejectedErrorV1("desired-workload");
			return;
		}
		if (
			!options.client.readMetadata ||
			(await options.client.readMetadata("Secret", route.tlsSecretName))
		)
			throw new WorkloadPreflightRejectedErrorV1("desired-workload");
		return { route, issuerName: selected.clusterIssuerName };
	}
	async function observe(value: AgentWorkloadDesiredV1) {
		const selected = options.policy.hostnameRoutes;
		if (!selected?.agentIds.includes(value.agentId) || value.replicas === 0)
			return "ready" as const;
		const route = workloadPublicRouteV1(options.policy, value.agentId);
		const current = await options.client.read<WorkloadHostnameCertificateV1>(
			"Certificate",
			route.tlsSecretName,
		);
		if (
			!current ||
			!matchesCertificate(current, {
				namespace: options.client.namespace,
				name: route.tlsSecretName,
				host: route.host,
				issuerName: selected.clusterIssuerName,
				agentId: value.agentId,
			}) ||
			!current.metadata?.uid ||
			!current.metadata.resourceVersion ||
			!Number.isSafeInteger(current.metadata.generation) ||
			(current.metadata.generation ?? 0) < 1 ||
			!options.client.readMetadata
		)
			return "certificate-invalid" as const;
		const secret = await options.client.readMetadata(
			"Secret",
			route.tlsSecretName,
		);
		if (
			secret &&
			!matchesSecretMetadata(
				secret,
				current,
				options.client.namespace,
				route.tlsSecretName,
			)
		)
			return "certificate-invalid" as const;
		const now = Date.now();
		const conditions = current.status?.conditions ?? [];
		const ready = conditions.filter((condition) => condition.type === "Ready");
		const issuing = conditions.filter(
			(condition) => condition.type === "Issuing",
		);
		if (
			ready.length > 1 ||
			issuing.length > 1 ||
			[...ready, ...issuing].some(
				(condition) =>
					condition.observedGeneration !== undefined &&
					condition.observedGeneration !== current.metadata?.generation,
			)
		)
			return "certificate-invalid" as const;
		const notAfter = Date.parse(current.status?.notAfter ?? "");
		const notBefore = current.status?.notBefore;
		if (ready[0]?.status === "True")
			return secret &&
				ready[0].observedGeneration === current.metadata.generation &&
				Number.isFinite(notAfter) &&
				notAfter > now &&
				(notBefore === undefined ||
					(Number.isFinite(Date.parse(notBefore)) &&
						Date.parse(notBefore) <= now))
				? ("ready" as const)
				: ("certificate-invalid" as const);
		if (current.status?.lastFailureTime && issuing[0]?.status !== "True")
			return "certificate-failed" as const;
		if (current.status?.notAfter !== undefined || notBefore !== undefined)
			return "certificate-invalid" as const;
		const createdAt = current.metadata.creationTimestamp;
		const start =
			createdAt === undefined ? Number.NaN : new Date(createdAt).getTime();
		if (!Number.isFinite(start) || start > now)
			return "certificate-invalid" as const;
		return now - start >= maximumIssuanceWaitMs
			? ("certificate-timeout" as const)
			: ("certificate-pending" as const);
	}

	return {
		async preflight(
			value: Pick<AgentWorkloadDesiredV1, "agentId" | "replicas">,
		) {
			await preparation(value);
		},
		observe,
		async ready(value: AgentWorkloadDesiredV1) {
			return (await observe(value)) === "ready";
		},
		async prepare(value: AgentWorkloadDesiredV1) {
			const plan = await preparation(value);
			if (!plan) return;
			const { route, issuerName } = plan;
			await options.client.create({
				apiVersion: "cert-manager.io/v1",
				kind: "Certificate",
				metadata: {
					namespace: options.client.namespace,
					name: route.tlsSecretName,
					labels: {
						[ownerLabel]: workloadResourceNameV1(value.agentId),
						"agent-infra.agora.io/managed": "agent-certificate-v1",
					},
					annotations: { [agentAnnotation]: value.agentId },
				},
				spec: {
					dnsNames: [route.host],
					usages: ["digital signature", "key encipherment", "server auth"],
					secretName: route.tlsSecretName,
					issuerRef: {
						group: "cert-manager.io",
						kind: "ClusterIssuer",
						name: issuerName,
					},
				},
			});
		},
	};
}
