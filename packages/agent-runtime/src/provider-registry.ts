import type { RuntimeCapabilitiesV1 } from "@agent-infra/contracts/runtime";

export type ProviderTemplate = "claude" | "pi" | "opencode" | "codex";
export type ProviderPath = "paseo-derived" | "agent-infra-native" | "paseo-sdk";
export type ProviderAdapter =
	| "claude-query"
	| "pi-jsonl-rpc"
	| "pi-paseo-sdk"
	| "generic-acp"
	| "codex-native"
	| "codex-app-server-sdk";

/** Fixed package-local metadata for one Runtime Driver implementation. */
export type RuntimeDriverBinding = Readonly<{
	template: ProviderTemplate;
	path: ProviderPath;
	adapter: ProviderAdapter;
}>;

/** Platform-owned evidence required before standard capabilities are enabled. */
export type ProviderCapabilityEvidence = Readonly<{
	runtimeDriverBinding: RuntimeDriverBinding;
	imageDigest: string;
	configurationRevision: number;
	conformance: "passed" | "failed" | "unknown";
	probe: "passed" | "failed" | "unknown";
	recovery: "supported" | "unsupported" | "unknown";
	result: "confirmed" | "unknown";
}>;

/** Complete deployment binding assembled by Platform and injected into Host. */
export type ProviderDeploymentBinding = Readonly<{
	runtimeDriverBinding: RuntimeDriverBinding;
	imageDigest: string;
	configurationRevision: number;
	evidence: ProviderCapabilityEvidence;
}>;

export type ProviderRegistration = {
	/** Runtime package owns this fixed seam. Platform owns deployment bindings. */
	readonly authority: "runtime-driver";
	readonly template: ProviderTemplate;
	readonly path: ProviderPath;
	readonly runtimeDriverBinding: RuntimeDriverBinding;
	readonly adapter: ProviderAdapter;
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

/** Fixed adapter registrations. Platform remains authoritative for deployment. */
export const PROVIDER_REGISTRY: Readonly<
	Record<ProviderTemplate, ProviderRegistration>
> = {
	claude: {
		authority: "runtime-driver",
		template: "claude",
		path: "paseo-derived",
		runtimeDriverBinding: {
			template: "claude",
			path: "paseo-derived",
			adapter: "claude-query",
		},
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
		runtimeDriverBinding: {
			template: "pi",
			path: "paseo-derived",
			adapter: "pi-jsonl-rpc",
		},
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
		runtimeDriverBinding: {
			template: "opencode",
			path: "paseo-derived",
			adapter: "generic-acp",
		},
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
		runtimeDriverBinding: {
			template: "codex",
			path: "agent-infra-native",
			adapter: "codex-native",
		},
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

export function assertProviderRegistration(
	template: ProviderTemplate,
	path: ProviderPath,
	adapter: ProviderAdapter,
): ProviderRegistration {
	const registration = resolveProviderRegistration(
		template,
		path === "paseo-sdk" ? "paseo-sdk-pod" : undefined,
	);
	if (registration.path !== path || registration.adapter !== adapter) {
		throw new Error("RUNTIME_PROVIDER_REGISTRATION_MISMATCH");
	}
	return registration;
}

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
	transport?: "paseo-sdk-pod",
): ProviderRegistration {
	if (template === "pi" && transport === "paseo-sdk-pod")
		return piSdkRegistration;
	if (template === "codex" && transport === "paseo-sdk-pod")
		return codexSdkRegistration;
	return PROVIDER_REGISTRY[template];
}

const codexSdkRegistration: ProviderRegistration = {
	authority: "runtime-driver",
	template: "codex",
	path: "paseo-sdk",
	adapter: "codex-app-server-sdk",
	runtimeDriverBinding: {
		template: "codex",
		path: "paseo-sdk",
		adapter: "codex-app-server-sdk",
	},
	provenance: {
		source: "paseo",
		repository: "getpaseo/paseo",
		sourceRevision: "v0.17.4",
		sourceCommit: "2b3559b107243306986176b80beb0e779f9fe53e",
		file: "packages/server/src/server/agent/providers/codex-app-server-agent.ts",
		symbol: "CodexAppServerAgent",
		sdk: "@getpaseo/client",
		version: "0.17.4",
		license: "Apache-2.0",
		copyright: "Copyright (c) 2025-present Mohamed Boudra",
		adaptations: [
			"platform-session-binding",
			"session-scoped-pod",
			"execution-key-loopback-proxy",
		],
		regressionEvidence: [
			"src/paseo-transport.test.ts",
			"src/paseo-native-session.test.ts",
			"src/codex-model-transport.test.ts",
		],
	},
};

const piSdkRegistration: ProviderRegistration = {
	...codexSdkRegistration,
	template: "pi",
	adapter: "pi-paseo-sdk",
	runtimeDriverBinding: {
		template: "pi",
		path: "paseo-sdk",
		adapter: "pi-paseo-sdk",
	},
	provenance: {
		...codexSdkRegistration.provenance,
		file: "packages/server/src/server/agent/providers/pi/agent.ts",
		symbol: "PiRpcAgentClient",
		regressionEvidence: [
			"src/paseo-native-session.test.ts",
			"src/pi-paseo-browser.test.ts",
		],
	},
};

/** Deployment configuration supplies the operator-reviewed rows for the installed release. */
export const providerEvidenceEnv = "AGENT_INFRA_RUNTIME_PROVIDER_EVIDENCE";
export const providerImageEnv = "AGENT_INFRA_RUNTIME_PROVIDER_IMAGE_DIGEST";
export function selectProviderDeploymentBinding(
	rows:
		| readonly (ProviderCapabilityEvidence & { configVersion: string })[]
		| undefined,
	driver: "codex" | "claude" | "acp" | "pi",
	imageDigest: string,
	configVersion: string,
): ProviderDeploymentBinding | undefined {
	const expected = resolveProviderRegistration(
		driver === "acp" ? "opencode" : driver,
	).runtimeDriverBinding;
	const revision = /^configuration-([1-9][0-9]*)-[a-f0-9]{64}$/.exec(
		configVersion,
	);
	if (!revision || !/^sha256:[a-f0-9]{64}$/.test(imageDigest)) return undefined;
	const configurationRevision = Number(revision[1]);
	const matches = rows?.filter(
		(row) =>
			row.configVersion === configVersion &&
			row.imageDigest === imageDigest &&
			row.configurationRevision === configurationRevision &&
			matchesRuntimeDriverBinding(expected, row.runtimeDriverBinding),
	);
	if (matches?.length !== 1) return undefined;
	return {
		runtimeDriverBinding: expected,
		imageDigest,
		configurationRevision,
		evidence: matches[0]!,
	};
}

/** Project Driver declarations only after Platform supplies complete evidence. */
export function projectProviderCapabilities(
	binding: ProviderDeploymentBinding | undefined,
	declared: RuntimeCapabilitiesV1,
	runtimeDriverBinding?: RuntimeDriverBinding,
): RuntimeCapabilitiesV1 {
	if (!binding) return disabledCapabilities();
	const registration = resolveProviderRegistration(
		binding.runtimeDriverBinding.template,
	);
	const expected = runtimeDriverBinding ?? registration.runtimeDriverBinding;
	const supplied = binding.runtimeDriverBinding;
	const evidenceBinding = binding.evidence.runtimeDriverBinding;
	const enabled =
		matchesRuntimeDriverBinding(expected, supplied) &&
		matchesRuntimeDriverBinding(supplied, evidenceBinding) &&
		binding.imageDigest === binding.evidence.imageDigest &&
		binding.configurationRevision === binding.evidence.configurationRevision &&
		/^sha256:[a-f0-9]{64}$/.test(binding.imageDigest) &&
		Number.isSafeInteger(binding.configurationRevision) &&
		binding.configurationRevision > 0 &&
		binding.evidence.conformance === "passed" &&
		binding.evidence.probe === "passed" &&
		binding.evidence.recovery === "supported" &&
		binding.evidence.result === "confirmed";
	return {
		modelSelection: enabled && declared.modelSelection,
		attachments: enabled && declared.attachments,
		resultFiles: enabled && declared.resultFiles,
		connection: enabled && declared.connection,
		supplementaryInstruction: enabled && declared.supplementaryInstruction,
		...(enabled && declared.skills ? { skills: declared.skills } : {}),
		...(enabled && declared.browser ? { browser: declared.browser } : {}),
	};
}

function disabledCapabilities(): RuntimeCapabilitiesV1 {
	return {
		modelSelection: false,
		attachments: false,
		resultFiles: false,
		connection: false,
		supplementaryInstruction: false,
	};
}

function matchesRuntimeDriverBinding(
	expected: RuntimeDriverBinding,
	actual: RuntimeDriverBinding,
): boolean {
	return (
		expected.template === actual.template &&
		expected.path === actual.path &&
		expected.adapter === actual.adapter
	);
}
