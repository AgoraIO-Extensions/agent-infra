import { BrowserCapabilityDiscoveryRequestV1Schema } from "@agent-infra/contracts/runtime";

/** Current Host has no approved production Browser assembly. */
export function discoverRuntimeBrowserCapabilityV1(request: unknown) {
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
	return {
		schemaVersion: 1 as const,
		capabilityVersion: 1,
		status: "not_configured" as const,
		errorCode: "BROWSER_CAPABILITY_NOT_CONFIGURED" as const,
		reason: "Production Browser capability is not configured",
		retryable: false,
	};
}
