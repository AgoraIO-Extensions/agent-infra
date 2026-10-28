import { createHash } from "node:crypto";
import { isIP } from "node:net";
import type {
	V1NetworkPolicy,
	V1NetworkPolicyEgressRule,
	V1NetworkPolicyPeer,
} from "@kubernetes/client-node";
import { WorkloadKubernetesError } from "./kubernetes-client.js";

/** Deployment-owned destinations; neither arbitrary CIDRs nor empty selectors are accepted. */
export type WorkloadEgressDestinationV1 =
	| { readonly ip: string }
	| { readonly cidr: string }
	| {
			readonly namespace: string;
			readonly podLabels: Readonly<Record<string, string>>;
	  };

export interface NativeEgressPolicyV1 {
	readonly destinations: readonly {
		readonly destination: { readonly ip: string } | { readonly cidr: string };
		readonly port: number;
	}[];
	readonly protectedNetworks: Readonly<
		Record<
			| "platformDatabase"
			| "connectionDatabase"
			| "kubernetesApi"
			| "sandboxPodNetworks",
			readonly string[]
		>
	>;
}

export interface WorkloadEgressPolicyV1 {
	/** Standard-template native tools only; never caller or Runtime authority. */
	readonly nativeEgress?: NativeEgressPolicyV1;
	readonly modelEgress?: readonly {
		readonly destination: WorkloadEgressDestinationV1;
		readonly port: number;
	}[];
	/** Compiled from the approved Connection Consumer snapshot/profile, never Runtime input. */
	readonly connectionEgress?: WorkloadEgressPolicyV1["modelEgress"];
	/** Fixed Worker native metadata callback destination. */
	readonly nativeMetadataWorkerEgress?: WorkloadEgressPolicyV1["modelEgress"];
	/**
	 * #3289：Runtime 文件交换 origin 的唯一出站目的地，由部署声明，端口取 origin 的端口。
	 * 只接受精确 IP 或 namespace/Pod 选择器，不接受 CIDR；Runtime 输入与 Owner env 不参与。
	 */
	readonly fileExchangeEgress?: WorkloadEgressPolicyV1["modelEgress"];
	readonly dnsEgress?: readonly WorkloadEgressDestinationV1[];
}

const namespacePattern = /^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/;
const labelNamePattern = /^[A-Za-z0-9](?:[-A-Za-z0-9_.]{0,61}[A-Za-z0-9])?$/;

type IpVersion = 4 | 6;
type IpRange = readonly [bigint, bigint];

const ipv4ReservedRanges: readonly (readonly [string, number])[] = [
	["0.0.0.0", 8],
	["10.0.0.0", 8],
	["100.64.0.0", 10],
	["127.0.0.0", 8],
	["169.254.0.0", 16],
	["172.16.0.0", 12],
	["192.0.0.0", 24],
	["192.0.2.0", 24],
	["192.88.99.0", 24],
	["192.168.0.0", 16],
	["198.18.0.0", 15],
	["198.51.100.0", 24],
	["203.0.113.0", 24],
	["224.0.0.0", 4],
	["240.0.0.0", 4],
];

const ipv6ReservedRanges: readonly (readonly [string, number])[] = [
	["::", 96],
	["::1", 128],
	["::ffff:0:0", 96],
	["64:ff9b::", 96],
	["64:ff9b:1::", 48],
	["100::", 64],
	["100:0:0:1::", 64],
	["2001::", 23],
	["2001:0::", 32],
	["2001:1::1", 128],
	["2001:1::2", 128],
	["2001:1::3", 128],
	["2001:2::", 48],
	["2001:3::", 32],
	["2001:4:112::", 48],
	["2001:10::", 28],
	["2001:20::", 28],
	["2001:30::", 28],
	["2001:db8::", 32],
	["2002::", 16],
	["2620:4f:8000::", 48],
	["3fff::", 20],
	["fc00::", 7],
	["fe80::", 10],
	["fec0::", 10],
	["ff00::", 8],
	["5f00::", 16],
];

function parseIpv4(value: string): bigint | undefined {
	const octets = value.split(".");
	if (octets.length !== 4 || octets.some((part) => !/^\d+$/.test(part)))
		return undefined;
	let result = 0n;
	for (const octet of octets) {
		const parsed = Number(octet);
		if (!Number.isInteger(parsed) || parsed < 0 || parsed > 255)
			return undefined;
		result = (result << 8n) | BigInt(parsed);
	}
	return result;
}

function parseIpv6(value: string): bigint | undefined {
	if (value.includes("%") || value.includes(".")) return undefined;
	const sections = value.split("::");
	if (sections.length > 2) return undefined;
	const left = sections[0] ? sections[0].split(":") : [];
	const right =
		sections.length === 2 && sections[1] ? sections[1].split(":") : [];
	if (
		left.some((part) => !/^[0-9A-Fa-f]{1,4}$/.test(part)) ||
		right.some((part) => !/^[0-9A-Fa-f]{1,4}$/.test(part))
	)
		return undefined;
	const groups =
		sections.length === 2
			? left.length + right.length >= 8
				? []
				: [
						...left,
						...Array.from(
							{ length: 8 - left.length - right.length },
							() => "0",
						),
						...right,
					]
			: [...left];
	if (groups.length !== 8) return undefined;
	let result = 0n;
	for (const group of groups) result = (result << 16n) | BigInt(`0x${group}`);
	return result;
}

function parseIp(
	value: string,
): { readonly version: IpVersion; readonly value: bigint } | undefined {
	const version = isIP(value);
	if (version === 4) {
		const parsed = parseIpv4(value);
		return parsed === undefined ? undefined : { version, value: parsed };
	}
	if (version === 6) {
		const parsed = parseIpv6(value);
		return parsed === undefined ? undefined : { version, value: parsed };
	}
	return undefined;
}

function ipRange(value: bigint, prefix: number, bits: 32 | 128): IpRange {
	const hostBits = BigInt(bits - prefix);
	const size = 1n << hostBits;
	const start = (value / size) * size;
	return [start, start + size - 1n];
}

function overlaps(left: IpRange, right: IpRange): boolean {
	return left[0] <= right[1] && right[0] <= left[1];
}

function formatIpv4(value: bigint): string {
	return [24n, 16n, 8n, 0n]
		.map((shift) => Number((value >> shift) & 255n))
		.join(".");
}

function formatIpv6(value: bigint): string {
	const groups = Array.from({ length: 8 }, (_, index) =>
		Number((value >> BigInt((7 - index) * 16)) & 0xffffn).toString(16),
	);
	let bestStart = -1;
	let bestLength = 0;
	for (let index = 0; index < groups.length; ) {
		if (groups[index] !== "0") {
			index += 1;
			continue;
		}
		const start = index;
		while (index < groups.length && groups[index] === "0") index += 1;
		if (index - start > bestLength) {
			bestStart = start;
			bestLength = index - start;
		}
	}
	if (bestLength < 2) return groups.join(":");
	const before = groups.slice(0, bestStart).join(":");
	const after = groups.slice(bestStart + bestLength).join(":");
	return `${before}:` + `:${after}`;
}

function parseBoundedCidr(value: unknown): string {
	if (typeof value !== "string") throw new WorkloadKubernetesError("policy");
	const match = /^(.*)\/([0-9]+)$/.exec(value);
	if (!match) throw new WorkloadKubernetesError("policy");
	const address = parseIp(match[1] ?? "");
	const prefix = Number(match[2]);
	if (!address || !Number.isSafeInteger(prefix))
		throw new WorkloadKubernetesError("policy");
	const bits = address.version === 4 ? 32 : 128;
	const minimumPrefix = address.version === 4 ? 16 : 48;
	if (prefix < minimumPrefix || prefix > bits)
		throw new WorkloadKubernetesError("policy");
	const range = ipRange(address.value, prefix, bits);
	if (range[0] !== address.value) throw new WorkloadKubernetesError("policy");
	if (
		address.version === 6 &&
		!overlaps(range, ipRange(0x20000000000000000000000000000000n, 3, 128))
	)
		throw new WorkloadKubernetesError("policy");
	const reserved =
		address.version === 4 ? ipv4ReservedRanges : ipv6ReservedRanges;
	for (const [reservedAddress, reservedPrefix] of reserved) {
		const parsed = parseIp(reservedAddress);
		if (!parsed) throw new WorkloadKubernetesError("policy");
		if (overlaps(range, ipRange(parsed.value, reservedPrefix, bits)))
			throw new WorkloadKubernetesError("policy");
	}
	const normalized =
		address.version === 4 ? formatIpv4(range[0]) : formatIpv6(range[0]);
	return `${normalized}/${prefix}`;
}

function networkRange(value: unknown) {
	if (typeof value !== "string") throw new WorkloadKubernetesError("policy");
	const parts = value.split("/");
	const address = parseIp(parts[0] ?? "");
	if (!address || parts.length > 2) throw new WorkloadKubernetesError("policy");
	const bits = address.version === 4 ? 32 : 128;
	const prefix = parts.length === 1 ? bits : Number(parts[1]);
	if (
		!Number.isSafeInteger(prefix) ||
		prefix < 0 ||
		prefix > bits ||
		(parts.length === 2 && !/^(0|[1-9][0-9]*)$/.test(parts[1] ?? ""))
	)
		throw new WorkloadKubernetesError("policy");
	const range = ipRange(address.value, prefix, bits);
	if (range[0] !== address.value) throw new WorkloadKubernetesError("policy");
	return { version: address.version, range };
}

function nativeRules(
	value: NativeEgressPolicyV1 | undefined,
): V1NetworkPolicyEgressRule[] {
	if (value === undefined) return [];
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.keys(value).sort().join(",") !== "destinations,protectedNetworks" ||
		!Array.isArray(value.destinations) ||
		!value.destinations.length ||
		value.destinations.length > 128 ||
		!value.protectedNetworks ||
		typeof value.protectedNetworks !== "object" ||
		Array.isArray(value.protectedNetworks) ||
		Object.keys(value.protectedNetworks).sort().join(",") !==
			"connectionDatabase,kubernetesApi,platformDatabase,sandboxPodNetworks"
	)
		throw new WorkloadKubernetesError("policy");
	const protectedRanges = Object.values(value.protectedNetworks).flatMap(
		(entries) => {
			if (
				!Array.isArray(entries) ||
				entries.length === 0 ||
				entries.length > 128
			)
				throw new WorkloadKubernetesError("policy");
			return entries.map(networkRange);
		},
	);
	return value.destinations.map((entry) => {
		if (
			!entry ||
			typeof entry !== "object" ||
			Array.isArray(entry) ||
			Object.keys(entry).sort().join(",") !== "destination,port" ||
			!Number.isSafeInteger(entry.port) ||
			entry.port < 1 ||
			entry.port > 65535 ||
			!entry.destination ||
			typeof entry.destination !== "object" ||
			Array.isArray(entry.destination) ||
			Object.keys(entry.destination).length !== 1
		)
			throw new WorkloadKubernetesError("policy");
		let cidr: string;
		if ("ip" in entry.destination) {
			const ip = entry.destination.ip;
			if (typeof ip !== "string" || !isIP(ip))
				throw new WorkloadKubernetesError("policy");
			cidr = parseBoundedCidr(`${ip}/${isIP(ip) === 4 ? 32 : 128}`);
		} else if ("cidr" in entry.destination) {
			cidr = parseBoundedCidr(entry.destination.cidr);
			if (cidr !== entry.destination.cidr)
				throw new WorkloadKubernetesError("policy");
		} else throw new WorkloadKubernetesError("policy");
		const target = networkRange(cidr);
		if (
			protectedRanges.some(
				(blocked) =>
					blocked.version === target.version &&
					overlaps(blocked.range, target.range),
			)
		)
			throw new WorkloadKubernetesError("policy");
		return {
			to: [{ ipBlock: { cidr } }],
			ports: [{ protocol: "TCP", port: entry.port }],
		};
	});
}

export const nativeEgressPolicyAnnotationV1 =
	"agent-infra.agora.io/native-egress-policy";
export function nativeEgressPolicyAnnotationsV1(
	value: NativeEgressPolicyV1 | undefined,
): Record<string, string> {
	return value === undefined
		? {}
		: {
				[nativeEgressPolicyAnnotationV1]: createHash("sha256")
					.update(JSON.stringify(value))
					.digest("hex"),
			};
}

/** NetworkPolicy allows are additive; unknown selectors conservatively overlap. */
export function hasAdditionalEgressPolicyV1(
	policies: readonly V1NetworkPolicy[],
	expected: V1NetworkPolicy,
) {
	const labels = expected.spec?.podSelector?.matchLabels ?? {};
	return policies.some((policy) => {
		if (
			policy.metadata?.name === expected.metadata?.name ||
			!(
				policy.spec?.policyTypes?.includes("Egress") ??
				!!policy.spec?.egress?.length
			) ||
			!policy.spec?.egress?.length
		)
			return false;
		if (policy.spec.podSelector?.matchExpressions?.length) return true;
		return !Object.entries(policy.spec.podSelector?.matchLabels ?? {}).some(
			([key, value]) => Object.hasOwn(labels, key) && labels[key] !== value,
		);
	});
}

function destinationPeer(
	value: WorkloadEgressDestinationV1,
	allowCidr: boolean,
): V1NetworkPolicyPeer {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new WorkloadKubernetesError("policy");
	if ("ip" in value) {
		if (
			Object.keys(value).length !== 1 ||
			typeof value.ip !== "string" ||
			!isIP(value.ip)
		)
			throw new WorkloadKubernetesError("policy");
		return {
			ipBlock: { cidr: `${value.ip}/${isIP(value.ip) === 4 ? 32 : 128}` },
		};
	}
	if ("cidr" in value) {
		if (!allowCidr || Object.keys(value).length !== 1)
			throw new WorkloadKubernetesError("policy");
		return { ipBlock: { cidr: parseBoundedCidr(value.cidr) } };
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
	const connections = policy.connectionEgress ?? [];
	const nativeMetadata = policy.nativeMetadataWorkerEgress ?? [];
	const fileExchange = policy.fileExchangeEgress ?? [];
	const dns = policy.dnsEgress ?? [];
	if (
		!Array.isArray(models) ||
		!Array.isArray(connections) ||
		!Array.isArray(nativeMetadata) ||
		!Array.isArray(fileExchange) ||
		!Array.isArray(dns) ||
		models.length > 128 ||
		connections.length > 128 ||
		nativeMetadata.length > 1 ||
		fileExchange.length > 1 ||
		dns.length > 16
	)
		throw new WorkloadKubernetesError("policy");
	const tcpRule =
		(allowCidr: boolean) =>
		(entry: NonNullable<WorkloadEgressPolicyV1["modelEgress"]>[number]) => {
			if (
				!entry ||
				Object.keys(entry).sort().join(",") !== "destination,port" ||
				!Number.isSafeInteger(entry.port) ||
				entry.port < 1 ||
				entry.port > 65_535
			)
				throw new WorkloadKubernetesError("policy");
			return {
				to: [destinationPeer(entry.destination, allowCidr)],
				ports: [{ protocol: "TCP", port: entry.port }],
			};
		};
	return [
		...[...models, ...connections, ...nativeMetadata].map(tcpRule(true)),
		// 文件交换只到单一 origin，不接受网段。
		...fileExchange.map(tcpRule(false)),
		...nativeRules(policy.nativeEgress),
		...dns.map((destination) => ({
			to: [destinationPeer(destination, false)],
			ports: [
				{ protocol: "UDP", port: 53 },
				{ protocol: "TCP", port: 53 },
			],
		})),
	];
}
