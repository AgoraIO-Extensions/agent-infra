import { createHash } from "node:crypto";
import type {
	KubernetesObject,
	V1Ingress,
	V1LabelSelector,
	V1NetworkPolicy,
	V1NetworkPolicyPeer,
	V1NetworkPolicyPort,
	V1Pod,
	V1PodSpec,
	V1Service,
} from "@kubernetes/client-node";
import type { KubernetesWorkloadPolicyV1 } from "./kubernetes-runtime-adapter.js";

export const ownerLabel = "agent-infra.agora.io/agent";
export const revisionLabel = "agent-infra.agora.io/revision";
export const agentAnnotation = "agent-infra.agora.io/agent-id";
export const fingerprintAnnotation = "agent-infra.agora.io/spec-hash";
export const desiredAnnotation = "agent-infra.agora.io/desired";
export const modelFingerprintAnnotation =
	"agent-infra.agora.io/model-config-hash";
export const controllerAnnotationPrefix = "agent-infra.agora.io/";
export const secretIdAnnotation = "agent-infra.agora.io/secret-id";
export const secretVersionAnnotation = "agent-infra.agora.io/secret-version";
export const secretConfigRevisionAnnotation =
	"agent-infra.agora.io/config-revision";

export function secretFenceAnnotation(secretName: string) {
	return `agent-infra.agora.io/secret-${createHash("sha256").update(secretName).digest("hex").slice(0, 32)}`;
}

export function secretUidAnnotation(secretName: string) {
	return `agent-infra.agora.io/secret-uid-${createHash("sha256").update(secretName).digest("hex").slice(0, 32)}`;
}

export type RouteSelectorMode = "closed" | "open";

export function hasSameStructure(actual: unknown, expected: unknown): boolean {
	if (Object.is(actual, expected)) return true;
	if (Array.isArray(actual) || Array.isArray(expected))
		return (
			Array.isArray(actual) &&
			Array.isArray(expected) &&
			actual.length === expected.length &&
			actual.every((entry, index) => hasSameStructure(entry, expected[index]))
		);
	if (
		actual === null ||
		expected === null ||
		typeof actual !== "object" ||
		typeof expected !== "object"
	)
		return false;
	const actualEntries = Object.entries(actual);
	const expectedRecord = expected as Record<string, unknown>;
	return (
		actualEntries.length === Object.keys(expectedRecord).length &&
		actualEntries.every(
			([key, value]) =>
				Object.hasOwn(expectedRecord, key) &&
				hasSameStructure(value, expectedRecord[key]),
		)
	);
}

// Compare quantities without float rounding or rejecting API-server canonical units.
export function quantityRatio(
	value: string,
): readonly [bigint, bigint] | undefined {
	if (value.length > 128) return undefined;
	const match =
		/^([+]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+))(n|u|m|k|M|G|T|P|E|Ki|Mi|Gi|Ti|Pi|Ei|[eE][+-]?[0-9]+)?$/.exec(
			value,
		);
	if (!match?.[1]) return undefined;
	const [integer, fraction = ""] = match[1].replace(/^\+/, "").split(".");
	let numerator = BigInt(`${integer || "0"}${fraction}`);
	let denominator = 10n ** BigInt(fraction.length);
	const suffix = match[2] ?? "";
	if (suffix.endsWith("i")) {
		numerator *=
			1024n ** BigInt(["Ki", "Mi", "Gi", "Ti", "Pi", "Ei"].indexOf(suffix) + 1);
	} else {
		const powers: Readonly<Record<string, number>> = {
			"": 0,
			n: -9,
			u: -6,
			m: -3,
			k: 3,
			M: 6,
			G: 9,
			T: 12,
			P: 15,
			E: 18,
		};
		const exponent = powers[suffix] ?? Number(suffix.slice(1));
		if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 30)
			return undefined;
		if (exponent < 0) denominator *= 10n ** BigInt(-exponent);
		else numerator *= 10n ** BigInt(exponent);
	}
	return [numerator, denominator];
}

export function matchesResources(
	actual: V1PodSpec["containers"][number]["resources"],
	expected: KubernetesWorkloadPolicyV1["resources"],
) {
	if (
		!actual ||
		!hasSameStructure(Object.keys(actual).sort(), ["limits", "requests"])
	)
		return false;
	return (["limits", "requests"] as const).every((kind) => {
		const values = actual[kind];
		if (
			!values ||
			!hasSameStructure(
				Object.keys(values).sort(),
				Object.keys(expected[kind]).sort(),
			)
		)
			return false;
		return Object.entries(expected[kind]).every(([key, value]) => {
			const observed = values[key];
			if (typeof observed !== "string") return false;
			const a = quantityRatio(observed);
			const b = quantityRatio(value);
			return a !== undefined && b !== undefined && a[0] * b[1] === b[0] * a[1];
		});
	});
}

export function containsDesired(actual: unknown, expected: unknown): boolean {
	if (Array.isArray(expected) && expected.length === 0 && actual === undefined)
		return true;
	if (Array.isArray(expected))
		return (
			Array.isArray(actual) &&
			actual.length === expected.length &&
			expected.every((entry, index) => containsDesired(actual[index], entry))
		);
	if (expected !== null && typeof expected === "object")
		return (
			actual !== null &&
			typeof actual === "object" &&
			Object.entries(expected).every(([key, value]) =>
				containsDesired((actual as Record<string, unknown>)[key], value),
			)
		);
	return actual === expected;
}

export function resourceFingerprint(object: KubernetesObject) {
	const { [fingerprintAnnotation]: _fingerprint, ...annotations } =
		object.metadata?.annotations ?? {};
	return createHash("sha256")
		.update(
			JSON.stringify({
				...object,
				metadata: { ...object.metadata, annotations },
			}),
		)
		.digest("hex");
}

export function agentContainerSecurityContext() {
	return {
		allowPrivilegeEscalation: false,
		readOnlyRootFilesystem: true,
		capabilities: { drop: ["ALL"] },
		runAsNonRoot: true,
		runAsUser: 1000,
		runAsGroup: 1000,
		seccompProfile: { type: "RuntimeDefault" },
		procMount: "Default",
	};
}

export function agentPodSecurityContext() {
	return {
		runAsNonRoot: true,
		runAsUser: 1000,
		runAsGroup: 1000,
		fsGroup: 1000,
		seccompProfile: { type: "RuntimeDefault" },
	};
}

export function matchesNetworkPolicySpec(
	actual: V1NetworkPolicy["spec"] | undefined,
	expected: V1NetworkPolicy["spec"] | undefined,
) {
	const selector = (value: V1LabelSelector | undefined) =>
		value ? { matchExpressions: [], ...value } : undefined;
	const peer = (value: V1NetworkPolicyPeer) => ({
		...value,
		...(value.podSelector ? { podSelector: selector(value.podSelector) } : {}),
		...(value.namespaceSelector
			? { namespaceSelector: selector(value.namespaceSelector) }
			: {}),
	});
	const normalize = (value: V1NetworkPolicy["spec"]) =>
		value && {
			...value,
			podSelector: selector(value.podSelector),
			ingress: value.ingress?.map((rule) => ({
				...rule,
				_from: rule._from?.map(peer),
				ports: rule.ports?.map(port),
			})),
			egress: (value.egress ?? []).map((rule) => ({
				...rule,
				to: rule.to?.map(peer),
				ports: rule.ports?.map(port),
			})),
		};
	function port(value: V1NetworkPolicyPort) {
		const { endPort, ...rest } = value;
		return {
			protocol: "TCP",
			...rest,
			...(endPort === undefined || endPort === value.port ? {} : { endPort }),
		};
	}
	return hasSameStructure(normalize(actual), normalize(expected));
}

export function matchesServiceSpec(
	actual: V1Service["spec"] | undefined,
	expected: V1Service["spec"] | undefined,
) {
	if (!actual || !expected) return actual === expected;
	const allowedSpecFields = new Set([
		"clusterIP",
		"clusterIPs",
		"internalTrafficPolicy",
		"ipFamilies",
		"ipFamilyPolicy",
		"ports",
		"selector",
		"sessionAffinity",
		"type",
	]);
	const allowedPortFields = new Set(["name", "port", "protocol", "targetPort"]);
	const actualPort = actual.ports?.[0];
	const expectedPort = expected.ports?.[0];
	return (
		Object.keys(actual).every((key) => allowedSpecFields.has(key)) &&
		actual.type === expected.type &&
		hasSameStructure(actual.selector, expected.selector) &&
		actual.ports?.length === 1 &&
		expected.ports?.length === 1 &&
		actualPort !== undefined &&
		expectedPort !== undefined &&
		Object.keys(actualPort).every((key) => allowedPortFields.has(key)) &&
		actualPort.name === expectedPort.name &&
		actualPort.port === expectedPort.port &&
		actualPort.targetPort === expectedPort.targetPort &&
		(actualPort.protocol === undefined || actualPort.protocol === "TCP") &&
		(actual.sessionAffinity === undefined ||
			actual.sessionAffinity === "None") &&
		(actual.internalTrafficPolicy === undefined ||
			actual.internalTrafficPolicy === "Cluster") &&
		actual.clusterIP !== "None" &&
		!actual.clusterIPs?.includes("None")
	);
}

export function matchesIngress(current: V1Ingress, expected: V1Ingress) {
	const hash = resourceFingerprint(expected);
	return (
		hasSameStructure(current.metadata?.labels, expected.metadata?.labels) &&
		hasSameStructure(current.metadata?.annotations, {
			...expected.metadata?.annotations,
			[fingerprintAnnotation]: hash,
		}) &&
		hasSameStructure(current.spec, expected.spec)
	);
}

export function routeSelector(
	name: string,
	workloadRevision: number,
	mode: RouteSelectorMode,
) {
	return {
		[ownerLabel]: name,
		[revisionLabel]: mode === "closed" ? "closed" : String(workloadRevision),
	};
}

export function hasClosedSelectorCollision(
	pods: readonly V1Pod[],
	name: string,
) {
	return pods.some(
		(pod) =>
			pod.metadata?.labels?.[ownerLabel] === name &&
			pod.metadata?.labels?.[revisionLabel] === "closed",
	);
}

export function workloadResourceNameV1(agentId: string): string {
	return `agent-${createHash("sha256").update(agentId).digest("hex").slice(0, 32)}`;
}
