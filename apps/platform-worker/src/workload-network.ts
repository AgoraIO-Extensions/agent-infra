import { isIP } from "node:net";
import type {
	V1NetworkPolicyEgressRule,
	V1NetworkPolicyPeer,
} from "@kubernetes/client-node";
import { WorkloadKubernetesError } from "./kubernetes-client.js";

/** Deployment-owned destinations; neither arbitrary CIDRs nor empty selectors are accepted. */
export type WorkloadEgressDestinationV1 =
	| { readonly ip: string }
	| {
			readonly namespace: string;
			readonly podLabels: Readonly<Record<string, string>>;
	  };

export interface WorkloadEgressPolicyV1 {
	readonly modelEgress?: readonly {
		readonly destination: WorkloadEgressDestinationV1;
		readonly port: number;
	}[];
	readonly dnsEgress?: readonly WorkloadEgressDestinationV1[];
}

const namespacePattern = /^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/;
const labelNamePattern = /^[A-Za-z0-9](?:[-A-Za-z0-9_.]{0,61}[A-Za-z0-9])?$/;

function destinationPeer(
	value: WorkloadEgressDestinationV1,
): V1NetworkPolicyPeer {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new WorkloadKubernetesError("policy");
	if ("ip" in value) {
		if (Object.keys(value).length !== 1 || !isIP(value.ip))
			throw new WorkloadKubernetesError("policy");
		return {
			ipBlock: { cidr: `${value.ip}/${isIP(value.ip) === 4 ? 32 : 128}` },
		};
	}
	if (
		Object.keys(value).sort().join(",") !== "namespace,podLabels" ||
		!namespacePattern.test(value.namespace) ||
		!value.podLabels ||
		typeof value.podLabels !== "object" ||
		Array.isArray(value.podLabels) ||
		Object.keys(value.podLabels).length === 0 ||
		Object.entries(value.podLabels).some(([key, label]) => {
			const parts = key.split("/");
			const name = parts.at(-1) ?? "";
			const prefix = parts[0] ?? "";
			return (
				parts.length > 2 ||
				!labelNamePattern.test(name) ||
				(parts.length === 2 &&
					(prefix.length > 253 ||
						!prefix.split(".").every((part) => namespacePattern.test(part)))) ||
				typeof label !== "string" ||
				(label !== "" && !labelNamePattern.test(label))
			);
		})
	)
		throw new WorkloadKubernetesError("policy");
	return {
		namespaceSelector: {
			matchLabels: { "kubernetes.io/metadata.name": value.namespace },
		},
		podSelector: { matchLabels: { ...value.podLabels } },
	};
}

export function workloadEgressRulesV1(
	policy: WorkloadEgressPolicyV1,
): V1NetworkPolicyEgressRule[] {
	const models = policy.modelEgress ?? [];
	const dns = policy.dnsEgress ?? [];
	if (
		!Array.isArray(models) ||
		!Array.isArray(dns) ||
		models.length > 128 ||
		dns.length > 16
	)
		throw new WorkloadKubernetesError("policy");
	return [
		...models.map((entry) => {
			if (
				!entry ||
				Object.keys(entry).sort().join(",") !== "destination,port" ||
				!Number.isSafeInteger(entry.port) ||
				entry.port < 1 ||
				entry.port > 65_535
			)
				throw new WorkloadKubernetesError("policy");
			return {
				to: [destinationPeer(entry.destination)],
				ports: [{ protocol: "TCP", port: entry.port }],
			};
		}),
		...dns.map((destination) => ({
			to: [destinationPeer(destination)],
			ports: [
				{ protocol: "UDP", port: 53 },
				{ protocol: "TCP", port: 53 },
			],
		})),
	];
}
