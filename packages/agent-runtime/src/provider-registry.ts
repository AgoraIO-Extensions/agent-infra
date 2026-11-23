export type ProviderTemplate = "claude" | "pi" | "opencode" | "codex";
export type ProviderPath = "paseo-derived" | "agent-infra-native";

export type ProviderRegistration = {
	readonly template: ProviderTemplate;
	readonly path: ProviderPath;
	readonly adapter: "claude-query" | "pi-jsonl-rpc" | "generic-acp" | "codex-native";
	readonly provenance: {
		readonly source: "paseo" | "agent-infra";
		readonly sourceCommit: string;
		readonly sdk: string;
		readonly version: string;
		readonly license: string;
		readonly adaptations: readonly string[];
	};
};

export const PROVIDER_REGISTRY: Readonly<Record<ProviderTemplate, ProviderRegistration>> = {
	claude: { template: "claude", path: "paseo-derived", adapter: "claude-query", provenance: { source: "paseo", sourceCommit: "d1b705a0cd91617a5707fae25d80cb0be305795", sdk: "@anthropic-ai/claude-agent-sdk", version: "0.3.246", license: "MIT", adaptations: ["runtime-host-driver-contract", "durable-recovery", "sandbox-and-credential-boundary"] } },
	pi: { template: "pi", path: "paseo-derived", adapter: "pi-jsonl-rpc", provenance: { source: "paseo", sourceCommit: "d1b705a0cd91617a5707fae25d80cb0be305795", sdk: "@earendil-works/pi-coding-agent", version: "0.99.0", license: "MIT", adaptations: ["runtime-host-driver-contract", "verified-session-checkpoint", "sandbox-and-credential-boundary"] } },
	opencode: { template: "opencode", path: "paseo-derived", adapter: "generic-acp", provenance: { source: "paseo", sourceCommit: "d1b705a0cd91617a5707fae25d80cb0be305795", sdk: "@agentclientprotocol/sdk", version: "1.4.0", license: "MIT", adaptations: ["runtime-host-driver-contract", "generic-acp-only", "sandbox-and-credential-boundary"] } },
	codex: { template: "codex", path: "agent-infra-native", adapter: "codex-native", provenance: { source: "agent-infra", sourceCommit: "41e22fee981a63b3698df7ed36bad393cda24715", sdk: "codex app-server", version: "0.153.0", license: "Apache-2.0", adaptations: ["native-execution-fence", "connection-mcp-boundary", "sandbox-and-credential-boundary"] } },
};

export function resolveProviderRegistration(template: ProviderTemplate, _requested?: unknown): ProviderRegistration {
	return PROVIDER_REGISTRY[template];
}

type Gate = "passed" | "failed" | "unknown";
export function projectProviderCapabilities(
	template: ProviderTemplate,
	evidence: { readonly conformance: Gate; readonly probe: Gate; readonly recovery: "supported" | "unsupported" | "unknown"; readonly result: "confirmed" | "unknown"; readonly declared: Readonly<Record<string, boolean>> },
): Record<string, boolean> {
	resolveProviderRegistration(template);
	const enabled = evidence.conformance === "passed" && evidence.probe === "passed" && evidence.recovery === "supported" && evidence.result === "confirmed";
	return Object.fromEntries(Object.entries(evidence.declared).map(([name, value]) => [name, enabled && value]));
}
