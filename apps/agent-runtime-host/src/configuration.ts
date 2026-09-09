import {
	type CodexRuntimeModelOption,
	validateCodexModelAccess,
} from "@agent-infra/agent-runtime";

export const CODEX_PILOT_CONFIGURATION_VERSION = 2;

export interface CodexPilotConfiguration {
	readonly configVersion: string;
	readonly defaultModelOptionId: string;
	readonly defaultReasoningLevel: string;
	readonly modelOptions: readonly CodexRuntimeModelOption[];
}

const identifier = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const reasoning = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const credentialEnvironmentVariable =
	/^AGENT_INFRA_RUNTIME_MODEL_CREDENTIAL_[A-Z0-9_]{1,96}$/;

export function runtimeConfigurationInvalid(): never {
	throw new Error("RUNTIME_CONFIGURATION_INVALID");
}

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function keys(value: Record<string, unknown>, expected: readonly string[]) {
	return (
		Object.keys(value).length === expected.length &&
		Object.keys(value).every((key) => expected.includes(key))
	);
}

export function readCodexPilotConfiguration(
	environment: NodeJS.ProcessEnv,
): CodexPilotConfiguration {
	let value: unknown;
	try {
		value = JSON.parse(environment.AGENT_INFRA_RUNTIME_MODEL_CONFIG ?? "");
	} catch {
		runtimeConfigurationInvalid();
	}
	if (
		!record(value) ||
		!keys(value, [
			"schemaVersion",
			"configVersion",
			"defaultModelOptionId",
			"defaultReasoningLevel",
			"modelOptions",
		]) ||
		value.schemaVersion !== CODEX_PILOT_CONFIGURATION_VERSION ||
		typeof value.configVersion !== "string" ||
		!identifier.test(value.configVersion) ||
		typeof value.defaultModelOptionId !== "string" ||
		!identifier.test(value.defaultModelOptionId) ||
		typeof value.defaultReasoningLevel !== "string" ||
		!reasoning.test(value.defaultReasoningLevel) ||
		!Array.isArray(value.modelOptions) ||
		value.modelOptions.length === 0 ||
		value.modelOptions.length > 128
	) {
		runtimeConfigurationInvalid();
	}
	const seen = new Set<string>();
	const seenCredentialEnvironmentVariables = new Set<string>();
	const modelOptions = value.modelOptions.map((option) => {
		if (
			!record(option) ||
			!keys(option, [
				"modelOptionId",
				"endpoint",
				"model",
				"reasoningLevels",
				"credentialEnvironmentVariable",
			]) ||
			typeof option.modelOptionId !== "string" ||
			!identifier.test(option.modelOptionId) ||
			seen.has(option.modelOptionId) ||
			typeof option.endpoint !== "string" ||
			option.endpoint.length > 2048 ||
			typeof option.model !== "string" ||
			!identifier.test(option.model) ||
			!Array.isArray(option.reasoningLevels) ||
			option.reasoningLevels.length === 0 ||
			option.reasoningLevels.some(
				(level) => typeof level !== "string" || !reasoning.test(level),
			) ||
			new Set(option.reasoningLevels).size !== option.reasoningLevels.length ||
			typeof option.credentialEnvironmentVariable !== "string" ||
			!credentialEnvironmentVariable.test(
				option.credentialEnvironmentVariable,
			) ||
			seenCredentialEnvironmentVariables.has(
				option.credentialEnvironmentVariable,
			)
		) {
			runtimeConfigurationInvalid();
		}
		const credential = environment[option.credentialEnvironmentVariable];
		let access: ReturnType<typeof validateCodexModelAccess>;
		try {
			access = validateCodexModelAccess({
				endpoint: option.endpoint,
				credential,
			});
		} catch {
			runtimeConfigurationInvalid();
		}
		if (!access) runtimeConfigurationInvalid();
		seen.add(option.modelOptionId);
		seenCredentialEnvironmentVariables.add(
			option.credentialEnvironmentVariable,
		);
		return {
			modelOptionId: option.modelOptionId,
			endpoint: access.endpoint,
			credential: access.credential,
			model: option.model,
			reasoningLevels: option.reasoningLevels as string[],
		};
	});
	if (
		!modelOptions.some(
			(option) =>
				option.modelOptionId === value.defaultModelOptionId &&
				option.reasoningLevels.includes(value.defaultReasoningLevel as string),
		)
	) {
		runtimeConfigurationInvalid();
	}
	return {
		configVersion: value.configVersion,
		defaultModelOptionId: value.defaultModelOptionId,
		defaultReasoningLevel: value.defaultReasoningLevel,
		modelOptions,
	};
}
