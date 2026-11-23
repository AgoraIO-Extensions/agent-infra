export type ProviderTemplate = "claude" | "pi" | "opencode" | "codex";
export type ProviderPath = "paseo-derived" | "agent-infra-native";

export type ProviderRegistration = {
	/** This package owns the fixed Runtime Driver seam only. Deployment bindings are Platform-owned. */
	readonly authority: "runtime-driver";
	readonly template: ProviderTemplate;
	readonly path: ProviderPath;
	readonly deploymentBinding: "platform-standard-template-release";
	readonly adapter:
		| "claude-query"
		| "pi-jsonl-rpc"
		| "generic-acp"
		| "codex-native";
	readonly provenance: {
		readonly source: "paseo" | "agent-infra";
		readonly repository: string;
		readonly sourceRevision: string;
		readonly sourceCommit: string;
		readonly file: string;
		readonly symbol: string;
		readonly sdk: string;
		readonly version: string;
		readonly license: string;
		readonly copyright: string;
		readonly adaptations: readonly string[];
		readonly regressionEvidence: readonly string[];
	};
};

/**
 * Fixed adapter registrations. The Platform registry remains authoritative for
 * image Digest, Service/health checks, capabilities and env/Secret bindings.
 */
export const PROVIDER_REGISTRY: Readonly<
	Record<ProviderTemplate, ProviderRegistration>
> = {
	claude: {
		authority: "runtime-driver",
		template: "claude",
		path: "paseo-derived",
		deploymentBinding: "platform-standard-template-release",
		adapter: "claude-query",
		provenance: {
			source: "paseo",
			repository: "getpaseo/paseo",
			sourceRevision: "d1b705a0cd91617a5707fae25d80cb0be3057950",
			sourceCommit: "d1b705a0cd91617a5707fae25d80cb0be305795",
			file: "packages/server/src/server/agent/providers/claude/query.ts",
			symbol: "applyRuntimeSettingsToClaudeOptions, claudeQuery",
			sdk: "@anthropic-ai/claude-agent-sdk",
			version: "0.3.246",
			license: "Apache-2.0",
			copyright: "Copyright (c) 2025-present Mohamed Boudra",
			adaptations: [
				"runtime-host-driver-contract",
				"durable-recovery",
				"sandbox-and-credential-boundary",
			],
			regressionEvidence: [
				"src/claude-runtime-driver.test.ts",
				"src/runtime-driver-conformance.test.ts",
			],
		},
	},
	pi: {
		authority: "runtime-driver",
		template: "pi",
		path: "paseo-derived",
		deploymentBinding: "platform-standard-template-release",
		adapter: "pi-jsonl-rpc",
		provenance: {
			source: "paseo",
			repository: "getpaseo/paseo",
			sourceRevision: "d1b705a0cd91617a5707fae25d80cb0be3057950",
			sourceCommit: "d1b705a0cd91617a5707fae25d80cb0be305795",
			file: "packages/server/src/server/agent/providers/pi/cli-runtime.ts",
			symbol: "PiCliRuntimeSession, buildPiLaunch",
			sdk: "@earendil-works/pi-coding-agent",
			version: "0.99.0",
			license: "MIT",
			copyright:
				"Copyright (c) 2025-present Mohamed Boudra; upstream package Copyright (c) 2025 Mario Zechner",
			adaptations: [
				"runtime-host-driver-contract",
				"verified-session-checkpoint",
				"sandbox-and-credential-boundary",
			],
			regressionEvidence: [
				"src/pi-runtime-driver.test.ts",
				"src/runtime-driver-conformance.test.ts",
			],
		},
	},
	opencode: {
		authority: "runtime-driver",
		template: "opencode",
		path: "paseo-derived",
		deploymentBinding: "platform-standard-template-release",
		adapter: "generic-acp",
		provenance: {
			source: "paseo",
			repository: "getpaseo/paseo",
			sourceRevision: "d1b705a0cd91617a5707fae25d80cb0be3057950",
			sourceCommit: "d1b705a0cd91617a5707fae25d80cb0be305795",
			file: "packages/server/src/server/agent/providers/acp-agent.ts",
			symbol: "initializeResumedSession, startTurn, handlePromptResponse",
			sdk: "@agentclientprotocol/sdk",
			version: "1.4.0",
			license: "Apache-2.0",
			copyright: "Copyright (c) 2025-present Mohamed Boudra",
			adaptations: [
				"runtime-host-driver-contract",
				"generic-acp-only",
				"sandbox-and-credential-boundary",
			],
			regressionEvidence: [
				"src/acp-runtime-driver.test.ts",
				"src/opencode-native.test.ts",
			],
		},
	},
	codex: {
		authority: "runtime-driver",
		template: "codex",
		path: "agent-infra-native",
		deploymentBinding: "platform-standard-template-release",
		adapter: "codex-native",
		provenance: {
			source: "agent-infra",
			repository: "openai/codex",
			sourceRevision: "41e22fee981a63b3698df7ed36bad393cda24715",
			sourceCommit: "41e22fee981a63b3698df7ed36bad393cda24715",
			file: "codex-rs/app-server",
			symbol: "app-server JSON-RPC transport",
			sdk: "codex app-server",
			version: "0.153.0",
			license: "Apache-2.0",
			copyright: "Copyright OpenAI",
			adaptations: [
				"native-execution-fence",
				"connection-mcp-boundary",
				"sandbox-and-credential-boundary",
			],
			regressionEvidence: [
				"src/codex-runtime-driver.test.ts",
				"src/runtime-driver-conformance.test.ts",
			],
		},
	},
};

/**
 * Resolve the fixed RuntimeHost seam and fail closed when an adapter claims a
 * different implementation path. Provider selection is deployment-owned.
 */
export function assertProviderRegistration(
	template: ProviderTemplate,
	path: ProviderPath,
	adapter: ProviderRegistration["adapter"],
): ProviderRegistration {
	const registration = PROVIDER_REGISTRY[template];
	if (registration.path !== path || registration.adapter !== adapter) {
		throw new Error("RUNTIME_PROVIDER_REGISTRATION_MISMATCH");
	}
	return registration;
}

/** Validate the complete fixed registration selected by a standard binding. */
export function assertRegisteredProvider(
	template: ProviderTemplate,
): ProviderRegistration {
	const registration = resolveProviderRegistration(template);
	return assertProviderRegistration(
		template,
		registration.path,
		registration.adapter,
	);
}

export function resolveProviderRegistration(
	template: ProviderTemplate,
): ProviderRegistration {
	return PROVIDER_REGISTRY[template];
}

type Gate = "passed" | "failed" | "unknown";
export function projectProviderCapabilities(
	template: ProviderTemplate,
	evidence: {
		readonly conformance: Gate;
		readonly probe: Gate;
		readonly recovery: "supported" | "unsupported" | "unknown";
		readonly result: "confirmed" | "unknown";
		readonly declared: Readonly<Record<string, boolean>>;
	},
): Record<string, boolean> {
	resolveProviderRegistration(template);
	const enabled =
		evidence.conformance === "passed" &&
		evidence.probe === "passed" &&
		evidence.recovery === "supported" &&
		evidence.result === "confirmed";
	return Object.fromEntries(
		Object.entries(evidence.declared).map(([name, value]) => [
			name,
			enabled && value,
		]),
	);
}
