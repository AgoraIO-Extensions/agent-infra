import {
	type BrowserCapabilityAvailableV1,
	BrowserCapabilityConformanceReceiptV1Schema,
	BrowserCapabilityDeclarationV1Schema,
	BrowserCapabilityDiscoveryRequestV1Schema,
	type BrowserCapabilityOperationV1,
	BrowserCapabilityOperationV1Schema,
	BrowserCapabilityProvenanceV1Schema,
} from "@agent-infra/contracts/runtime";

const BROWSER_CAPABILITY_MAX_RECEIPT_AGE_MS = 5 * 60 * 1000;

export interface RuntimeBrowserCapabilityProbeEvidenceV1 {
	readonly capabilityVersion: number;
	readonly operations: readonly BrowserCapabilityOperationV1[];
	readonly provenance: unknown;
	readonly conformance: unknown;
}

export interface RuntimeBrowserCapabilityAssemblyInputV1 {
	readonly declaration: unknown;
	readonly manifestDigest: string;
	readonly probe: unknown;
	readonly now?: () => number;
	readonly maxReceiptAgeMs?: number;
}

function unavailable(
	status: "not_configured" | "probe_failed" | "unavailable" | "stale",
	errorCode:
		| "BROWSER_CAPABILITY_NOT_CONFIGURED"
		| "BROWSER_CAPABILITY_PROBE_FAILED"
		| "BROWSER_CAPABILITY_UNAVAILABLE"
		| "BROWSER_CAPABILITY_STALE",
	reason: string,
	retryable: boolean,
) {
	return {
		schemaVersion: 1 as const,
		capabilityVersion: 1,
		status,
		errorCode,
		reason,
		retryable,
	};
}

function assembleAvailable(
	input: RuntimeBrowserCapabilityAssemblyInputV1,
): BrowserCapabilityAvailableV1 | ReturnType<typeof unavailable> {
	const declaration = BrowserCapabilityDeclarationV1Schema.safeParse(
		input.declaration,
	);
	if (!declaration.success) {
		return unavailable(
			"unavailable",
			"BROWSER_CAPABILITY_UNAVAILABLE",
			"Browser capability declaration is unavailable",
			false,
		);
	}
	if (!input.probe) {
		return unavailable(
			"probe_failed",
			"BROWSER_CAPABILITY_PROBE_FAILED",
			"Browser capability probe evidence is unavailable",
			true,
		);
	}
	const probe = input.probe as Partial<RuntimeBrowserCapabilityProbeEvidenceV1>;
	const capabilityVersion =
		typeof probe.capabilityVersion === "number"
			? probe.capabilityVersion
			: undefined;
	const operations = Array.isArray(probe.operations)
		? probe.operations
				.map((operation) =>
					BrowserCapabilityOperationV1Schema.safeParse(operation),
				)
				.filter((result) => result.success)
				.map((result) => result.data)
		: [];
	const provenance = BrowserCapabilityProvenanceV1Schema.safeParse(
		probe.provenance,
	);
	const conformance = BrowserCapabilityConformanceReceiptV1Schema.safeParse(
		probe.conformance,
	);
	if (
		capabilityVersion !== declaration.data.capabilityVersion ||
		operations.length !==
			(Array.isArray(probe.operations) ? probe.operations.length : 0) ||
		!provenance.success ||
		!conformance.success
	) {
		return unavailable(
			"probe_failed",
			"BROWSER_CAPABILITY_PROBE_FAILED",
			"Browser capability probe evidence does not match the declaration",
			true,
		);
	}
	if (conformance.data.manifestDigest !== input.manifestDigest) {
		return unavailable(
			"probe_failed",
			"BROWSER_CAPABILITY_PROBE_FAILED",
			"Browser capability receipt does not match the admitted manifest",
			false,
		);
	}
	const verifiedAt = Date.parse(conformance.data.verifiedAt);
	const now = (input.now ?? Date.now)();
	const maxAge = input.maxReceiptAgeMs ?? BROWSER_CAPABILITY_MAX_RECEIPT_AGE_MS;
	if (
		!Number.isFinite(verifiedAt) ||
		!Number.isFinite(now) ||
		!Number.isFinite(maxAge) ||
		maxAge < 0 ||
		now < verifiedAt ||
		now - verifiedAt > maxAge
	) {
		return unavailable(
			"stale",
			"BROWSER_CAPABILITY_STALE",
			"Browser capability conformance receipt is stale",
			true,
		);
	}
	const declared = new Set(declaration.data.operations);
	const conformanceOperations = new Set(conformance.data.operations);
	const intersectedOperations = operations.filter(
		(operation) =>
			declared.has(operation) && conformanceOperations.has(operation),
	);
	if (!intersectedOperations.length) {
		return unavailable(
			"probe_failed",
			"BROWSER_CAPABILITY_PROBE_FAILED",
			"Browser capability probe exposes no declared operation",
			true,
		);
	}
	return {
		schemaVersion: 1 as const,
		capabilityVersion: declaration.data.capabilityVersion,
		status: "available" as const,
		operations: intersectedOperations,
		policy: declaration.data.policy,
		provenance: provenance.data,
		conformance: conformance.data,
	};
}

/** Current Host has no approved production Browser assembly. */
export function discoverRuntimeBrowserCapabilityV1(
	request: unknown,
	assembly?: RuntimeBrowserCapabilityAssemblyInputV1,
) {
	// Schema libraries may ignore prototype-related keys. Preserve strictness
	// against the complete decoded query without maintaining a second key list.
	const unknownKeys =
		typeof request === "object" &&
		request !== null &&
		Object.keys(request).some(
			(key) =>
				!Object.hasOwn(BrowserCapabilityDiscoveryRequestV1Schema.shape, key),
		);
	const parsed = BrowserCapabilityDiscoveryRequestV1Schema.safeParse(request);
	if (!parsed.success || unknownKeys) {
		return {
			schemaVersion: 1 as const,
			code: "BROWSER_CAPABILITY_POLICY_DENIED" as const,
			reason: "Browser capability discovery request is invalid",
			retryable: false,
		};
	}
	if (
		parsed.data.minimumCapabilityVersion !== undefined &&
		parsed.data.minimumCapabilityVersion > 1
	) {
		return {
			schemaVersion: 1 as const,
			code: "BROWSER_CAPABILITY_VERSION_UNSUPPORTED" as const,
			reason: "Browser capability version is not supported",
			retryable: false,
		};
	}
	if (!assembly)
		return unavailable(
			"not_configured",
			"BROWSER_CAPABILITY_NOT_CONFIGURED",
			"Production Browser capability is not configured",
			false,
		);
	return assembleAvailable(assembly);
}
