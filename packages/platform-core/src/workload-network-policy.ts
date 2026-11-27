import { createHash } from "node:crypto";
import { isIP } from "node:net";

/** Thrown for any invalid deployment egress input; callers map it to their own policy error. */
export class WorkloadEgressPolicyError extends Error {
	constructor() {
		super("policy");
	}
}

export interface NetworkPolicyPeerV1 {
	ipBlock?: { cidr: string; except?: string[] };
	namespaceSelector?: { matchLabels: Record<string, string> };
	podSelector?: { matchLabels: Record<string, string> };
}
export interface NetworkPolicyEgressRuleV1 {
	to: NetworkPolicyPeerV1[];
	ports: { protocol: string; port: number }[];
}

/** Deployment-owned destinations; neither arbitrary CIDRs nor empty selectors are accepted. */
export type WorkloadEgressDestinationV1 =
	| { readonly ip: string }
	| { readonly cidr: string }
	| {
			readonly namespace: string;
			readonly podLabels: Readonly<Record<string, string>>;
	  };

type ProtectedNetworks = Readonly<
	Record<
		| "platformDatabase"
		| "connectionDatabase"
		| "kubernetesApi"
		| "sandboxPodNetworks",
		readonly string[]
	>
>;

export type NativeEgressPolicyV1 = {
	readonly protectedNetworks: ProtectedNetworks;
} & (
	| {
			readonly mode?: never;
			readonly destinations: readonly {
				readonly destination:
					| { readonly ip: string }
					| { readonly cidr: string };
				readonly port: number;
			}[];
	  }
	| { readonly mode: "public-web"; readonly destinations?: never }
);

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
	/** Snapshot materializer target; only compiled when a trusted snapshot projection is present. */
	readonly workspaceSnapshotEgress?: readonly {
		readonly destination: Exclude<
			WorkloadEgressDestinationV1,
			{ readonly cidr: string }
		>;
		readonly port: number;
	}[];
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
	if (typeof value !== "string") throw new WorkloadEgressPolicyError();
	const match = /^(.*)\/([0-9]+)$/.exec(value);
	if (!match) throw new WorkloadEgressPolicyError();
	const address = parseIp(match[1] ?? "");
	const prefix = Number(match[2]);
	if (!address || !Number.isSafeInteger(prefix))
		throw new WorkloadEgressPolicyError();
	const bits = address.version === 4 ? 32 : 128;
	const minimumPrefix = address.version === 4 ? 16 : 48;
	if (prefix < minimumPrefix || prefix > bits)
		throw new WorkloadEgressPolicyError();
	const range = ipRange(address.value, prefix, bits);
	if (range[0] !== address.value) throw new WorkloadEgressPolicyError();
	if (
		address.version === 6 &&
		!overlaps(range, ipRange(0x20000000000000000000000000000000n, 3, 128))
	)
		throw new WorkloadEgressPolicyError();
	const reserved =
		address.version === 4 ? ipv4ReservedRanges : ipv6ReservedRanges;
	for (const [reservedAddress, reservedPrefix] of reserved) {
		const parsed = parseIp(reservedAddress);
		if (!parsed) throw new WorkloadEgressPolicyError();
		if (overlaps(range, ipRange(parsed.value, reservedPrefix, bits)))
			throw new WorkloadEgressPolicyError();
	}
	const normalized =
		address.version === 4 ? formatIpv4(range[0]) : formatIpv6(range[0]);
	return `${normalized}/${prefix}`;
}

function networkRange(value: unknown) {
	if (typeof value !== "string") throw new WorkloadEgressPolicyError();
	const parts = value.split("/");
	const ip = parts[0] ?? "";
	// net.isIP also accepts IPv6 addresses with a dotted IPv4 suffix. Canonicalize that syntax for ipBlock exceptions.
	const normalized =
		ip.includes(".") && !ip.includes("%") && isIP(ip) === 6
			? new URL("http://[" + ip + "]").hostname.slice(1, -1)
			: ip;
	const address = parseIp(normalized);
	if (!address || parts.length > 2) throw new WorkloadEgressPolicyError();
	const bits = address.version === 4 ? 32 : 128;
	const prefix = parts.length === 1 ? bits : Number(parts[1]);
	if (
		!Number.isSafeInteger(prefix) ||
		prefix < 0 ||
		prefix > bits ||
		(parts.length === 2 && !/^(0|[1-9][0-9]*)$/.test(parts[1] ?? ""))
	)
		throw new WorkloadEgressPolicyError();
	const range = ipRange(address.value, prefix, bits);
	if (range[0] !== address.value) throw new WorkloadEgressPolicyError();
	const canonical =
		address.version === 4 ? formatIpv4(range[0]) : formatIpv6(range[0]);
	return { version: address.version, range, cidr: canonical + "/" + prefix };
}

/** Kubernetes requires each exception to be a strict subnet of the outer IP block. */
function publicWebPeer(
	cidr: string,
	reserved: readonly (readonly [string, number])[],
	protectedRanges: readonly ReturnType<typeof networkRange>[],
): NetworkPolicyPeerV1[] {
	const outer = networkRange(cidr);
	const ranges = [
		...reserved.map(([ip, prefix]) => networkRange(ip + "/" + prefix)),
		...protectedRanges,
	].filter(
		(block) =>
			block.version === outer.version && overlaps(outer.range, block.range),
	);
	if (
		ranges.some(
			(block) =>
				block.range[0] <= outer.range[0] && block.range[1] >= outer.range[1],
		)
	)
		return [];
	// Stable order and no redundant narrower exclusions, including reserved or repeated deployment ranges.
	const byAddress = (
		left: (typeof ranges)[number],
		right: (typeof ranges)[number],
	) => {
		const start = left.range[0] - right.range[0];
		return start === 0n
			? Number(right.range[1] - left.range[1])
			: Number(start);
	};
	let lastEnd = -1n;
	const except: string[] = [];
	for (const block of ranges.sort(byAddress)) {
		if (block.range[1] > lastEnd) {
			except.push(block.cidr);
			lastEnd = block.range[1];
		}
	}
	return [{ ipBlock: { cidr, except } }];
}

function nativeRules(
	value: NativeEgressPolicyV1 | undefined,
	serviceRules: NetworkPolicyEgressRuleV1[],
): NetworkPolicyEgressRuleV1[] {
	if (value === undefined) return [];
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		!value.protectedNetworks ||
		typeof value.protectedNetworks !== "object" ||
		Array.isArray(value.protectedNetworks) ||
		Object.keys(value.protectedNetworks).sort().join(",") !==
			"connectionDatabase,kubernetesApi,platformDatabase,sandboxPodNetworks"
	)
		throw new WorkloadEgressPolicyError();
	const protectedRanges = Object.values(value.protectedNetworks).flatMap(
		(entries) => {
			if (
				!Array.isArray(entries) ||
				entries.length === 0 ||
				entries.length > 128
			)
				throw new WorkloadEgressPolicyError();
			return Array.from(entries, networkRange);
		},
	);
	if (value.mode === "public-web") {
		if (Object.keys(value).sort().join(",") !== "mode,protectedNetworks")
			throw new WorkloadEgressPolicyError();
		for (const rule of serviceRules) {
			for (const peer of rule.to) {
				if (peer.ipBlock) protectedRanges.push(networkRange(peer.ipBlock.cidr));
			}
		}
		const to = [
			...publicWebPeer(
				"0.0.0.0/0",
				[
					...ipv4ReservedRanges,
					["192.31.196.0", 24],
					["192.52.193.0", 24],
					["192.175.48.0", 24],
				],
				protectedRanges,
			),
			...publicWebPeer("2000::/3", ipv6ReservedRanges, protectedRanges),
		];
		// An empty 'to' would allow every destination.
		return to.length
			? [
					{
						to,
						ports: [
							{ protocol: "TCP", port: 80 },
							{ protocol: "TCP", port: 443 },
						],
					},
				]
			: [];
	}
	if (
		Object.keys(value).sort().join(",") !== "destinations,protectedNetworks" ||
		!Array.isArray(value.destinations) ||
		!value.destinations.length ||
		value.destinations.length > 128
	)
		throw new WorkloadEgressPolicyError();
	return Array.from(value.destinations, (entry) => {
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
			throw new WorkloadEgressPolicyError();
		let cidr: string;
		if ("ip" in entry.destination) {
			const ip = entry.destination.ip;
			if (typeof ip !== "string" || !isIP(ip))
				throw new WorkloadEgressPolicyError();
			cidr = parseBoundedCidr(`${ip}/${isIP(ip) === 4 ? 32 : 128}`);
		} else if ("cidr" in entry.destination) {
			cidr = parseBoundedCidr(entry.destination.cidr);
			if (cidr !== entry.destination.cidr)
				throw new WorkloadEgressPolicyError();
		} else throw new WorkloadEgressPolicyError();
		const target = networkRange(cidr);
		if (
			protectedRanges.some(
				(blocked) =>
					blocked.version === target.version &&
					overlaps(blocked.range, target.range),
			)
		)
			throw new WorkloadEgressPolicyError();
		return {
			to: [{ ipBlock: { cidr } }],
			ports: [{ protocol: "TCP", port: entry.port }],
		};
	});
}

function destinationPeer(
	value: WorkloadEgressDestinationV1,
	allowCidr: boolean,
): NetworkPolicyPeerV1 {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new WorkloadEgressPolicyError();
	if ("ip" in value) {
		if (
			Object.keys(value).length !== 1 ||
			typeof value.ip !== "string" ||
			!isIP(value.ip)
		)
			throw new WorkloadEgressPolicyError();
		return {
			ipBlock: { cidr: `${value.ip}/${isIP(value.ip) === 4 ? 32 : 128}` },
		};
	}
	if ("cidr" in value) {
		if (!allowCidr || Object.keys(value).length !== 1)
			throw new WorkloadEgressPolicyError();
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
		throw new WorkloadEgressPolicyError();
	return {
		namespaceSelector: {
			matchLabels: { "kubernetes.io/metadata.name": value.namespace },
		},
		podSelector: { matchLabels: { ...value.podLabels } },
	};
}

export function compileWorkloadEgressRulesV1(
	policy: WorkloadEgressPolicyV1,
): NetworkPolicyEgressRuleV1[] {
	const models = policy.modelEgress ?? [];
	const connections = policy.connectionEgress ?? [];
	const nativeMetadata = policy.nativeMetadataWorkerEgress ?? [];
	const fileExchange = policy.fileExchangeEgress ?? [];
	const workspaceSnapshot = policy.workspaceSnapshotEgress ?? [];
	const dns = policy.dnsEgress ?? [];
	if (
		!Array.isArray(models) ||
		!Array.isArray(connections) ||
		!Array.isArray(nativeMetadata) ||
		!Array.isArray(fileExchange) ||
		!Array.isArray(workspaceSnapshot) ||
		!Array.isArray(dns) ||
		models.length > 128 ||
		connections.length > 128 ||
		nativeMetadata.length > 1 ||
		fileExchange.length > 1 ||
		workspaceSnapshot.length > 8 ||
		dns.length > 16
	)
		throw new WorkloadEgressPolicyError();
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
				throw new WorkloadEgressPolicyError();
			return {
				to: [destinationPeer(entry.destination, allowCidr)],
				ports: [{ protocol: "TCP", port: entry.port }],
			};
		};
	const services = [
		...[...models, ...connections, ...nativeMetadata].map(tcpRule(true)),
		...fileExchange.map(tcpRule(false)),
		...workspaceSnapshot.map(tcpRule(false)),
	];
	const dnsRules = dns.map((destination) => ({
		to: [destinationPeer(destination, false)],
		ports: [
			{ protocol: "UDP", port: 53 },
			{ protocol: "TCP", port: 53 },
		],
	}));
	return [
		...services,
		...nativeRules(policy.nativeEgress, [...services, ...dnsRules]),
		...dnsRules,
	];
}

// ---------------------------------------------------------------------------
// Agent-level NetworkPolicy template (Engineering Spec §10.1, ADR-0049, #4351).
//
// The Worker renders every Agent NetworkPolicy spec through `networkPolicySpecV1`;
// the ACK deployment preflight calls the same function with an empty substitution
// table (placeholders kept) to digest the normalized template, and the probe
// package uses a probe-only substitution table. Nothing may duplicate this shape.
// This file must stay importable by Node type stripping: node: imports only.
// ---------------------------------------------------------------------------

export const agentNetworkPolicyOwnerLabelV1 = "agent-infra.agora.io/agent";
export const agentNetworkPolicyServiceLabelV1 = "agent-infra.agora.io/service";
export const agentPlaceholderV1 = "<agent>";
export const portPlaceholderV1 = "<port>";
export const servicePlaceholderV1 = "<service>";

export const networkPolicyBaseVariantsV1 = [
	"internal-only",
	"self-managed",
	"platform-auth",
	"multi-service-entry",
	"multi-service-service",
	"multi-service-migration",
] as const;
export type NetworkPolicyBaseVariantV1 =
	(typeof networkPolicyBaseVariantsV1)[number];
/**
 * `<base>[+snapshot][+no-native]`. `+snapshot`: workspace snapshot projection and
 * egress both deployed. `+no-native`: a single-service Agent without a standard
 * template binding, whose Worker drops `nativeEgress` before rendering.
 */
export type NetworkPolicyVariantV1 =
	| NetworkPolicyBaseVariantV1
	| `${NetworkPolicyBaseVariantV1}+snapshot`
	| `${NetworkPolicyBaseVariantV1}+no-native`
	| `${NetworkPolicyBaseVariantV1}+snapshot+no-native`;

export interface NetworkPolicyDeploymentConfigV1 {
	/** Required by single-service variants; multi-service policies have no Worker source. */
	readonly workerSelector?: Readonly<Record<string, string>>;
	/** Namespace of the route (ingress controller) Pods; required by single-service variants. */
	readonly routeNamespace?: string;
	readonly routeSelector: Readonly<Record<string, string>>;
	readonly platformApiSelector?: Readonly<Record<string, string>>;
	readonly workspaceSnapshotProjection?: boolean;
	readonly egress: WorkloadEgressPolicyV1;
}

/** Probe-only values; omitted entries keep their placeholder (the deployment template). */
export interface NetworkPolicySubstitutionsV1 {
	readonly agentSelector?: { readonly key: string; readonly value: string };
	/** Replaces the Worker source labels of single-service variants. */
	readonly workerSource?: Readonly<Record<string, string>>;
	/** Single-service ingress port. */
	readonly port?: number;
	/** Multi-service `agent-infra.agora.io/service` value of non-migration variants. */
	readonly service?: string;
}

export interface NetworkPolicySpecV1 {
	podSelector: { matchLabels: Record<string, string> };
	policyTypes: ("Ingress" | "Egress")[];
	ingress: {
		from?: NetworkPolicyPeerV1[];
		ports?: { protocol: string; port: number | string }[];
	}[];
	egress?: (NetworkPolicyEgressRuleV1 | { to: NetworkPolicyPeerV1[] })[];
}

const snapshotSuffix = "+snapshot";
const noNativeSuffix = "+no-native";
const isSingle = (base: NetworkPolicyBaseVariantV1) =>
	base === "internal-only" ||
	base === "self-managed" ||
	base === "platform-auth";

export function splitNetworkPolicyVariantV1(variant: string): {
	base: NetworkPolicyBaseVariantV1;
	snapshot: boolean;
	noNative: boolean;
} {
	const noNative = variant.endsWith(noNativeSuffix);
	const rest = noNative ? variant.slice(0, -noNativeSuffix.length) : variant;
	const snapshot = rest.endsWith(snapshotSuffix);
	const base = snapshot ? rest.slice(0, -snapshotSuffix.length) : rest;
	if (
		!(networkPolicyBaseVariantsV1 as readonly string[]).includes(base) ||
		(noNative && !isSingle(base as NetworkPolicyBaseVariantV1))
	)
		throw new WorkloadEgressPolicyError();
	return { base: base as NetworkPolicyBaseVariantV1, snapshot, noNative };
}

/** Every form the Worker can render for this deployment configuration. */
export function networkPolicyVariantsV1(
	config: NetworkPolicyDeploymentConfigV1,
): NetworkPolicyVariantV1[] {
	const snapshot =
		config.workspaceSnapshotProjection === true &&
		(config.egress.workspaceSnapshotEgress?.length ?? 0) > 0;
	const native = config.egress.nativeEgress?.destinations !== undefined;
	return networkPolicyBaseVariantsV1.flatMap((base) => {
		const forms = [base, ...(snapshot ? [`${base}${snapshotSuffix}`] : [])];
		return [
			...forms,
			...(native && isSingle(base)
				? forms.map((f) => `${f}${noNativeSuffix}`)
				: []),
		] as NetworkPolicyVariantV1[];
	});
}

const selectorMap = (value: unknown, required: boolean) => {
	if (value === undefined && !required) return undefined;
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.keys(value).length === 0 ||
		Object.keys(value).length > 16 ||
		Object.entries(value).some(
			([key, label]) =>
				!labelKeyPattern.test(key) ||
				typeof label !== "string" ||
				(label !== "" && !labelNamePattern.test(label)),
		)
	)
		throw new WorkloadEgressPolicyError();
	return { ...(value as Record<string, string>) };
};
const labelKeyPattern =
	/^(?:[a-z0-9](?:[-a-z0-9.]{0,251}[a-z0-9])?\/)?[A-Za-z0-9](?:[-A-Za-z0-9_.]{0,61}[A-Za-z0-9])?$/;

/** Validates deployment-supplied configuration; any problem throws WorkloadEgressPolicyError. */
export function parseNetworkPolicyDeploymentConfigV1(
	value: unknown,
): NetworkPolicyDeploymentConfigV1 {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new WorkloadEgressPolicyError();
	const input = value as Record<string, unknown>;
	const allowed = new Set([
		"workerSelector",
		"routeNamespace",
		"routeSelector",
		"platformApiSelector",
		"workspaceSnapshotProjection",
		"egress",
	]);
	if (
		Object.keys(input).some((key) => !allowed.has(key)) ||
		typeof input.routeNamespace !== "string" ||
		!namespacePattern.test(input.routeNamespace) ||
		(input.workspaceSnapshotProjection !== undefined &&
			typeof input.workspaceSnapshotProjection !== "boolean") ||
		!input.egress ||
		typeof input.egress !== "object" ||
		Array.isArray(input.egress)
	)
		throw new WorkloadEgressPolicyError();
	const egressKeys = new Set([
		"nativeEgress",
		"modelEgress",
		"connectionEgress",
		"nativeMetadataWorkerEgress",
		"fileExchangeEgress",
		"workspaceSnapshotEgress",
		"dnsEgress",
	]);
	if (Object.keys(input.egress).some((key) => !egressKeys.has(key)))
		throw new WorkloadEgressPolicyError();
	const config: NetworkPolicyDeploymentConfigV1 = {
		workerSelector: selectorMap(input.workerSelector, true) as Record<
			string,
			string
		>,
		routeNamespace: input.routeNamespace,
		routeSelector: selectorMap(input.routeSelector, true) as Record<
			string,
			string
		>,
		...(input.platformApiSelector === undefined
			? {}
			: {
					platformApiSelector: selectorMap(
						input.platformApiSelector,
						true,
					) as Record<string, string>,
				}),
		...(input.workspaceSnapshotProjection === undefined
			? {}
			: {
					workspaceSnapshotProjection: input.workspaceSnapshotProjection,
				}),
		egress: input.egress as WorkloadEgressPolicyV1,
	};
	if (config.egress.nativeEgress?.mode === "public-web")
		compileWorkloadEgressRulesV1(config.egress);
	// Every Agent variant must compile.
	for (const variant of networkPolicyVariantsV1(config))
		networkPolicySpecV1({ variant, config });
	return config;
}

function matchLabels(labels: Readonly<Record<string, string>>) {
	return { matchLabels: { ...labels } };
}

/**
 * Effective NetworkPolicy spec of one variant. With no substitutions the Agent
 * value, port and service are placeholders (the normalized template); the Worker
 * passes the real values. `egress` lets the Worker hand over rules it already
 * compiled from the same deployment policy.
 */
export function networkPolicySpecV1(input: {
	readonly variant: NetworkPolicyVariantV1;
	readonly config: NetworkPolicyDeploymentConfigV1;
	readonly substitutions?: NetworkPolicySubstitutionsV1;
	readonly egress?: readonly NetworkPolicyEgressRuleV1[];
}): NetworkPolicySpecV1 {
	const { base, snapshot, noNative } = splitNetworkPolicyVariantV1(
		input.variant,
	);
	const { config } = input;
	const substitutions = input.substitutions ?? {};
	const agent = substitutions.agentSelector ?? {
		key: agentNetworkPolicyOwnerLabelV1,
		value: agentPlaceholderV1,
	};
	const agentLabels = { [agent.key]: agent.value };
	const single = isSingle(base);
	if (
		snapshot &&
		!(
			config.workspaceSnapshotProjection === true &&
			(config.egress.workspaceSnapshotEgress?.length ?? 0) > 0
		)
	)
		throw new WorkloadEgressPolicyError();
	const withSnapshot = (
		policy: WorkloadEgressPolicyV1,
	): WorkloadEgressPolicyV1 => ({
		...policy,
		...(snapshot ? {} : { workspaceSnapshotEgress: undefined }),
		...(noNative || policy.nativeEgress?.mode === "public-web"
			? { nativeEgress: undefined }
			: {}),
	});

	if (single) {
		const port = substitutions.port ?? portPlaceholderV1;
		const ports = [{ protocol: "TCP", port }];
		if (
			config.routeNamespace === undefined ||
			(substitutions.workerSource === undefined &&
				config.workerSelector === undefined)
		)
			throw new WorkloadEgressPolicyError();
		const route = {
			namespaceSelector: {
				matchLabels: {
					"kubernetes.io/metadata.name": config.routeNamespace,
				},
			},
			podSelector: matchLabels(config.routeSelector),
		};
		return {
			podSelector: matchLabels(agentLabels),
			policyTypes: ["Ingress", "Egress"],
			ingress: [
				{
					from: [
						{
							podSelector: matchLabels(
								substitutions.workerSource ??
									(config.workerSelector as Record<string, string>),
							),
						},
					],
					ports,
				},
				...(base === "internal-only"
					? []
					: [
							{
								from: [
									route,
									...(base === "platform-auth" && config.platformApiSelector
										? [
												{
													podSelector: matchLabels(config.platformApiSelector),
												},
											]
										: []),
								],
								ports,
							},
						]),
			],
			egress: structuredClone(
				(input.egress ??
					compileWorkloadEgressRulesV1(
						withSnapshot(config.egress),
					)) as NetworkPolicyEgressRuleV1[],
			),
		};
	}

	const sameAgent = { podSelector: matchLabels(agentLabels) };
	const egress = snapshot
		? [
				...(input.egress ??
					compileWorkloadEgressRulesV1({
						modelEgress: config.egress.modelEgress,
						connectionEgress: config.egress.connectionEgress,
						nativeMetadataWorkerEgress:
							config.egress.nativeMetadataWorkerEgress,
						fileExchangeEgress: config.egress.fileExchangeEgress,
						workspaceSnapshotEgress: config.egress.workspaceSnapshotEgress,
						dnsEgress: config.egress.dnsEgress,
					})),
				{ to: [structuredClone(sameAgent)] },
			]
		: undefined;
	const policyTypes: ("Ingress" | "Egress")[] = snapshot
		? ["Ingress", "Egress"]
		: ["Ingress"];
	if (base === "multi-service-migration")
		return {
			podSelector: matchLabels({
				...agentLabels,
				[agentNetworkPolicyServiceLabelV1]: "migration",
			}),
			policyTypes,
			ingress: [],
			...(egress ? { egress } : {}),
		};
	const routePeer = {
		podSelector: matchLabels(config.routeSelector),
		...(config.routeNamespace
			? {
					namespaceSelector: {
						matchLabels: {
							"kubernetes.io/metadata.name": config.routeNamespace,
						},
					},
				}
			: {}),
	};
	return {
		podSelector: matchLabels({
			...agentLabels,
			[agentNetworkPolicyServiceLabelV1]:
				substitutions.service ?? servicePlaceholderV1,
		}),
		policyTypes,
		ingress: [
			{
				from: [
					structuredClone(sameAgent),
					...(base === "multi-service-entry" ? [routePeer] : []),
				],
			},
		],
		...(egress ? { egress } : {}),
	};
}

/** Key-sorted deep copy so equal specs serialize identically. */
export function canonicalJsonValueV1(value: unknown): unknown {
	return Array.isArray(value)
		? value.map(canonicalJsonValueV1)
		: value && typeof value === "object"
			? Object.fromEntries(
					Object.keys(value)
						.sort()
						.filter(
							(key) => (value as Record<string, unknown>)[key] !== undefined,
						)
						.map((key) => [
							key,
							canonicalJsonValueV1((value as Record<string, unknown>)[key]),
						]),
				)
			: value;
}

/** `networkPolicySpecSha256V1`: SHA-256 of the canonical JSON of a spec. */
export function networkPolicySpecSha256V1(spec: unknown): string {
	return createHash("sha256")
		.update(JSON.stringify(canonicalJsonValueV1(spec ?? {})))
		.digest("hex");
}

/**
 * Evidence digest of one NetworkPolicy: the canonical effective spec plus the
 * native tool egress protected networks the compiler checked it against. The
 * protected networks are inputs that never appear in the spec, so a hash of the
 * spec alone would not change when they change (Spec §10.1).
 */
export function networkPolicyEvidenceSha256V1(
	spec: unknown,
	config: NetworkPolicyDeploymentConfigV1,
): string {
	return createHash("sha256")
		.update(
			JSON.stringify(
				canonicalJsonValueV1({
					spec: spec ?? {},
					protectedNetworks:
						config.egress.nativeEgress?.mode === "public-web"
							? null
							: (config.egress.nativeEgress?.protectedNetworks ?? null),
				}),
			),
		)
		.digest("hex");
}

/** Digest of every variant's normalized template (empty substitution table). */
export function networkPolicyTemplateDigestsV1(
	config: NetworkPolicyDeploymentConfigV1,
): Record<string, string> {
	return Object.fromEntries(
		networkPolicyVariantsV1(config).map((variant) => [
			variant,
			networkPolicyEvidenceSha256V1(
				networkPolicySpecV1({ variant, config }),
				config,
			),
		]),
	);
}

// ---------------------------------------------------------------------------
// Worker final network configuration. The Worker deployment entry and the ACK
// preflight both resolve the file exchange and native metadata egress through
// these functions, so the preflight digests what the Worker actually renders.
// ---------------------------------------------------------------------------

const DNS_NAME =
	/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/i;
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/** Exact HTTP(S) origin without credentials, path, query or fragment. */
export function isFileExchangeOriginV1(value: unknown): value is string {
	if (typeof value !== "string" || value.length > 512) return false;
	let origin: URL;
	try {
		origin = new URL(value);
	} catch {
		return false;
	}
	if (
		(origin.protocol !== "http:" && origin.protocol !== "https:") ||
		origin.origin !== value ||
		origin.username !== "" ||
		origin.password !== "" ||
		(origin.pathname !== "/" && origin.pathname !== "") ||
		origin.search !== "" ||
		origin.hash !== ""
	)
		return false;
	// In-cluster cleartext is limited to DNS Service names. HTTPS may also use
	// a deployment-approved external address.
	return (
		origin.protocol === "https:" ||
		(DNS_NAME.test(origin.hostname) &&
			!IPV4.test(origin.hostname) &&
			!origin.hostname.startsWith("["))
	);
}

/**
 * Resolve the optional file exchange origin from the mounted deployment module
 * and the fixed environment seam. The mounted module stays authoritative; a
 * duplicate, an origin without Runtime auth, or an invalid origin fails closed
 * before any Kubernetes resource is written.
 */
export function resolveWorkloadFileExchangeOriginV1(input: {
	readonly configured?: string;
	readonly environment?: string;
	readonly hasRuntimeAuth: boolean;
}): string | undefined {
	const environment =
		input.environment === undefined || input.environment === ""
			? undefined
			: input.environment;
	if (input.configured !== undefined && environment !== undefined)
		throw new Error("PLATFORM_WORKER_FILE_EXCHANGE_DUPLICATE");
	if (environment !== undefined) {
		if (!input.hasRuntimeAuth || !isFileExchangeOriginV1(environment))
			throw new Error("PLATFORM_WORKER_FILE_EXCHANGE_CONFIGURATION_INVALID");
		return environment;
	}
	return input.configured;
}

/** TCP port an exact file exchange origin connects to (explicit or scheme default). */
export function fileExchangeOriginPortV1(origin: string): number {
	const url = new URL(origin);
	return url.port === ""
		? url.protocol === "https:"
			? 443
			: 80
		: Number(url.port);
}

/**
 * #3289：文件交换 egress 与 origin 必须同时存在或同时缺失；存在时只有一条、只到部署
 * 声明的单一目的地（精确 IP 或 namespace/Pod 选择器），端口等于 origin 的端口。
 */
export function isWorkloadFileExchangeEgressCurrentV1(
	origin: string | undefined,
	egress: WorkloadEgressPolicyV1["fileExchangeEgress"],
): boolean {
	if (origin === undefined) return egress === undefined;
	if (
		!isFileExchangeOriginV1(origin) ||
		!Array.isArray(egress) ||
		egress.length !== 1 ||
		egress[0]?.port !== fileExchangeOriginPortV1(origin)
	)
		return false;
	try {
		compileWorkloadEgressRulesV1({ fileExchangeEgress: egress });
		return true;
	} catch {
		return false;
	}
}

/**
 * Resolve the file exchange egress from the mounted deployment module
 * (`policy.fileExchangeEgress`) or the fixed environment seam
 * (`PLATFORM_WORKER_FILE_EXCHANGE_EGRESS`, a JSON destination). The port is
 * always the origin's port. A duplicate source, an egress without origin, an
 * origin without egress, or an invalid destination fails closed before any
 * Kubernetes resource is written.
 */
export function resolveWorkloadFileExchangeEgressV1(input: {
	readonly origin?: string;
	readonly configured?: WorkloadEgressPolicyV1["fileExchangeEgress"];
	readonly environment?: string;
}): WorkloadEgressPolicyV1["fileExchangeEgress"] {
	const environment =
		input.environment === undefined || input.environment === ""
			? undefined
			: input.environment;
	if (input.configured !== undefined && environment !== undefined)
		throw new Error("PLATFORM_WORKER_FILE_EXCHANGE_DUPLICATE");
	if (input.origin !== undefined && !isFileExchangeOriginV1(input.origin))
		throw new Error("PLATFORM_WORKER_FILE_EXCHANGE_CONFIGURATION_INVALID");
	let egress = input.configured;
	if (environment !== undefined) {
		if (input.origin === undefined || environment.length > 4096)
			throw new Error("PLATFORM_WORKER_FILE_EXCHANGE_CONFIGURATION_INVALID");
		let destination: WorkloadEgressDestinationV1;
		try {
			destination = JSON.parse(environment);
		} catch {
			throw new Error("PLATFORM_WORKER_FILE_EXCHANGE_CONFIGURATION_INVALID");
		}
		egress = [{ destination, port: fileExchangeOriginPortV1(input.origin) }];
	}
	if (!isWorkloadFileExchangeEgressCurrentV1(input.origin, egress))
		throw new Error("PLATFORM_WORKER_FILE_EXCHANGE_CONFIGURATION_INVALID");
	return egress;
}

/** Port of the native metadata gateway: module value, else the environment, else 3004. */
export function resolveNativeMetadataGatewayPortV1(input: {
	/** `nativeMetadataGateway` exported by the deployment module, if any. */
	readonly configured?: { readonly port?: number };
	readonly environment: Readonly<Record<string, string | undefined>>;
	readonly hasRuntimeAuth: boolean;
}): number | undefined {
	const invalid = () =>
		new Error("PLATFORM_WORKER_NATIVE_METADATA_GATEWAY_CONFIGURATION_INVALID");
	const enabled =
		input.environment.PLATFORM_WORKER_NATIVE_METADATA_GATEWAY_ENABLED;
	let fromEnvironment: number | undefined;
	if (enabled !== undefined && enabled !== "false") {
		if (enabled !== "true") throw invalid();
		const port = Number(
			input.environment.PLATFORM_WORKER_NATIVE_METADATA_GATEWAY_PORT ?? "3004",
		);
		if (!Number.isSafeInteger(port) || port < 1 || port > 65_535)
			throw invalid();
		fromEnvironment = port;
	}
	const enabledAny =
		input.configured !== undefined || fromEnvironment !== undefined;
	const port =
		input.configured?.port ??
		fromEnvironment ??
		(enabledAny ? 3004 : undefined);
	if (enabledAny && !input.hasRuntimeAuth) throw invalid();
	return port;
}

/** Egress to the Worker native metadata gateway, derived when the module declares none. */
export function nativeMetadataWorkerEgressV1(input: {
	readonly port: number;
	readonly namespace: string;
	readonly releaseName: string | undefined;
}): NonNullable<WorkloadEgressPolicyV1["nativeMetadataWorkerEgress"]> {
	if (
		!input.releaseName ||
		!/^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/.test(input.releaseName)
	)
		throw new Error(
			"PLATFORM_WORKER_NATIVE_METADATA_GATEWAY_CONFIGURATION_INVALID",
		);
	return [
		{
			destination: {
				namespace: input.namespace,
				podLabels: {
					"app.kubernetes.io/component": "platform-worker",
					"app.kubernetes.io/instance": input.releaseName,
				},
			},
			port: input.port,
		},
	];
}

/**
 * The Worker's final egress inputs: the deployment module policy merged with the
 * file exchange and native metadata gateway values the Worker resolves from its
 * fixed environment seams (`deployment-entry.ts` calls exactly this).
 */
export function resolveWorkerEffectiveEgressV1(input: {
	readonly policy: WorkloadEgressPolicyV1 & {
		readonly runtimeAuth?: { readonly fileExchangeOrigin?: string };
	};
	readonly nativeMetadataGateway?: { readonly port?: number };
	/** The Worker container environment (`process.env` in the Worker). */
	readonly environment: Readonly<Record<string, string | undefined>>;
}): {
	readonly policy: WorkloadEgressPolicyV1;
	readonly fileExchangeOrigin: string | undefined;
	readonly nativeMetadataGatewayPort: number | undefined;
} {
	const { policy, environment } = input;
	const nativeMetadataGatewayPort = resolveNativeMetadataGatewayPortV1({
		configured: input.nativeMetadataGateway,
		environment,
		hasRuntimeAuth: policy.runtimeAuth !== undefined,
	});
	const fileExchangeOrigin = resolveWorkloadFileExchangeOriginV1({
		configured: policy.runtimeAuth?.fileExchangeOrigin,
		environment: environment.PLATFORM_WORKER_FILE_EXCHANGE_ORIGIN,
		hasRuntimeAuth: policy.runtimeAuth !== undefined,
	});
	const fileExchangeEgress = resolveWorkloadFileExchangeEgressV1({
		origin: fileExchangeOrigin,
		configured: policy.fileExchangeEgress,
		environment: environment.PLATFORM_WORKER_FILE_EXCHANGE_EGRESS,
	});
	// Validated whenever the gateway is enabled, even if the module declares its own egress.
	const derived =
		nativeMetadataGatewayPort === undefined
			? undefined
			: nativeMetadataWorkerEgressV1({
					port: nativeMetadataGatewayPort,
					namespace: environment.PLATFORM_WORKER_NAMESPACE ?? "",
					releaseName: environment.PLATFORM_WORKER_RELEASE_NAME,
				});
	return {
		policy: {
			...policy,
			...(fileExchangeEgress ? { fileExchangeEgress } : {}),
			...(derived && policy.nativeMetadataWorkerEgress === undefined
				? { nativeMetadataWorkerEgress: derived }
				: {}),
		},
		fileExchangeOrigin,
		nativeMetadataGatewayPort,
	};
}
