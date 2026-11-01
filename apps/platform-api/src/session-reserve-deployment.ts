import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import {
	parseSessionSandboxReserveConfigurationV1,
	type SessionSandboxReserveConfigurationV1,
	sessionSandboxReserveDigestV1,
} from "@agent-infra/platform-core";

const invalid = "SESSION_RESERVE_DEPLOYMENT_CONFIGURATION_INVALID";
const configurationKeys = [
	"schemaVersion",
	"enabled",
	"revision",
	"namespace",
	"totalBudget",
	"resourceCosts",
	"maximumReserves",
	"maximumConcurrentCreates",
	"ttlMs",
	"cooldownMs",
	"failureBackoffMs",
	"profiles",
];
const profileKeys = [
	"agentId",
	"templateId",
	"imageDigest",
	"resourceConfigurationHash",
	"resources",
	"storageConfigurationVersion",
	"networkPolicyVersion",
	"signingConfigurationVersion",
	"transportConfigurationVersion",
	"connectionConfigurationVersion",
	"minimum",
	"maximum",
];

function record(
	value: unknown,
	keys: readonly string[],
): Record<string, unknown> {
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.keys(value).some((key) => !keys.includes(key))
	)
		throw new Error(invalid);
	return value as Record<string, unknown>;
}

function parse(input: unknown) {
	try {
		const value = record(input, [...configurationKeys, "sourceSha"]);
		const { sourceSha, ...configuration } = value;
		if (
			sourceSha !== undefined &&
			(typeof sourceSha !== "string" || !/^[a-f0-9]{40}$/.test(sourceSha))
		)
			throw new Error(invalid);
		// Core owns policy validation; this deployment boundary excludes undeclared metadata.
		if (
			typeof configuration.namespace !== "string" ||
			!Array.isArray(configuration.resourceCosts) ||
			!Array.isArray(configuration.profiles)
		)
			throw new Error(invalid);
		for (const cost of configuration.resourceCosts)
			record(cost, ["resourceConfigurationHash", "resources"]);
		for (const profile of configuration.profiles) {
			const value = record(profile, profileKeys);
			if (
				typeof value.agentId !== "string" ||
				typeof value.templateId !== "string"
			)
				throw new Error(invalid);
		}
		return {
			configuration: parseSessionSandboxReserveConfigurationV1(
				configuration as unknown as SessionSandboxReserveConfigurationV1,
			),
			sourceSha: sourceSha ?? null,
			configurationHash: sessionSandboxReserveDigestV1(value),
		};
	} catch {
		throw new Error(invalid);
	}
}

/** Startup-only configuration; private readback uses the same captured policy as the API. */
export async function loadPlatformApiSessionReserveDeploymentV1(
	moduleConfiguration: unknown,
	explicitFile?: string,
) {
	const file = explicitFile ?? "/app/deployment/session-reserves.json";
	if (!isAbsolute(file) || /[\0\r\n]/.test(file)) throw new Error(invalid);
	let bytes: string | undefined;
	try {
		bytes = await readFile(file, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT")
			throw new Error(invalid);
		if (explicitFile !== undefined)
			throw new Error("SESSION_RESERVE_DEPLOYMENT_CONFIGURATION_MISSING");
	}
	let fromFile: ReturnType<typeof parse> | undefined;
	if (bytes !== undefined) {
		try {
			if (Buffer.byteLength(bytes) > 1024 * 1024) throw new Error(invalid);
			fromFile = parse(JSON.parse(bytes));
		} catch {
			throw new Error(invalid);
		}
	}
	const fromModule =
		moduleConfiguration === undefined ? undefined : parse(moduleConfiguration);
	if (
		fromFile &&
		fromModule &&
		sessionSandboxReserveDigestV1(fromFile.configuration) !==
			sessionSandboxReserveDigestV1(fromModule.configuration)
	)
		throw new Error("SESSION_RESERVE_DEPLOYMENT_CONFIGURATION_CONFLICT");
	return {
		source: fromFile ? ("file" as const) : ("module" as const),
		sourceSha: fromFile?.sourceSha ?? null,
		configurationHash: fromFile?.configurationHash ?? null,
		configuration: fromFile?.configuration ?? fromModule?.configuration ?? null,
	};
}
