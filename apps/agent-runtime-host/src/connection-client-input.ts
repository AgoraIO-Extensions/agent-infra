import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";

import {
	type CodexRuntimeDriverOptions,
	type FileRuntimeStore,
	isCodexConnectionClientConfiguration,
} from "@agent-infra/agent-runtime";
import { RuntimePrincipalV1Schema } from "@agent-infra/contracts/runtime";

import { runtimeConfigurationInvalid } from "./configuration.js";
import { assertRuntimeProcessProtection } from "./process-protection.js";

type ClientOptions = NonNullable<CodexRuntimeDriverOptions["connectionClient"]>;
type OriginalBinding = Awaited<
	ReturnType<FileRuntimeStore["resolveOriginalExecutionBinding"]>
>;
const metadataId = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const maximumInputBytes = 32_768;

function record(value: unknown): value is Record<string, unknown> {
	return (
		value !== null &&
		typeof value === "object" &&
		!Array.isArray(value) &&
		Object.getPrototypeOf(value) === Object.prototype
	);
}

/** Nonsecret deployment target. Independent access tokens never come from env. */
export function readConnectionClientProfile(
	value: string | undefined,
): ClientOptions["profile"] | undefined {
	if (value === undefined) return undefined;
	try {
		const parsed: unknown = JSON.parse(value);
		if (
			!record(parsed) ||
			Object.keys(parsed).sort().join(",") !==
				"issuer,profileRef,resource,serviceRef" ||
			typeof parsed.profileRef !== "string" ||
			!metadataId.test(parsed.profileRef) ||
			typeof parsed.serviceRef !== "string" ||
			!metadataId.test(parsed.serviceRef) ||
			typeof parsed.issuer !== "string" ||
			typeof parsed.resource !== "string"
		)
			runtimeConfigurationInvalid();
		for (const address of [parsed.issuer, parsed.resource]) {
			const url = new URL(address);
			if (
				address.length > 2048 ||
				url.protocol !== "https:" ||
				url.username ||
				url.password ||
				url.search ||
				url.hash ||
				address.includes("?") ||
				address.includes("#") ||
				(url.href !== address && url.origin !== address)
			)
				runtimeConfigurationInvalid();
		}
		if (new URL(parsed.resource).pathname !== "/mcp")
			runtimeConfigurationInvalid();
		return {
			profileRef: parsed.profileRef,
			serviceRef: parsed.serviceRef,
			issuer: parsed.issuer,
			resource: parsed.resource,
		};
	} catch {
		return runtimeConfigurationInvalid();
	}
}

async function readIndependentInput(
	dataDirectory: string,
	profile: ClientOptions["profile"],
	binding: OriginalBinding,
) {
	const inputDirectory = join(dataDirectory, "independent-client-input");
	const inputId = createHash("sha256")
		.update(
			JSON.stringify([
				binding.principal.kind,
				binding.principal.id,
				binding.scope.agentId,
				profile.profileRef,
			]),
		)
		.digest("hex");
	try {
		const directory = await open(
			inputDirectory,
			constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
		);
		try {
			const directoryStat = await directory.stat();
			if (
				!directoryStat.isDirectory() ||
				directoryStat.uid !== process.getuid?.() ||
				(directoryStat.mode & 0o777) !== 0o700 ||
				(await realpath(inputDirectory)) !== inputDirectory
			)
				return undefined;
			const directoryPath =
				process.platform === "linux"
					? `/proc/self/fd/${directory.fd}`
					: inputDirectory;
			const handle = await open(
				join(directoryPath, `${inputId}.json`),
				constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
			);
			try {
				if (
					process.platform !== "linux" &&
					(await realpath(inputDirectory)) !== inputDirectory
				)
					return undefined;
				const before = await handle.stat();
				if (
					!before.isFile() ||
					before.uid !== process.getuid?.() ||
					before.nlink !== 1 ||
					![0o400, 0o600].includes(before.mode & 0o777) ||
					before.size < 1 ||
					before.size > maximumInputBytes
				)
					return undefined;
				const bytes = Buffer.alloc(before.size);
				try {
					let offset = 0;
					while (offset < bytes.length) {
						const { bytesRead } = await handle.read(
							bytes,
							offset,
							bytes.length - offset,
							offset,
						);
						if (bytesRead === 0) return undefined;
						offset += bytesRead;
					}
					const after = await handle.stat();
					if (
						offset !== before.size ||
						after.dev !== before.dev ||
						after.ino !== before.ino ||
						after.nlink !== before.nlink ||
						after.nlink !== 1 ||
						after.size !== before.size ||
						after.mtimeMs !== before.mtimeMs ||
						after.ctimeMs !== before.ctimeMs
					)
						return undefined;
					const input: unknown = JSON.parse(bytes.toString("utf8"));
					if (
						!record(input) ||
						Object.keys(input).sort().join(",") !==
							"agentId,client,principal" ||
						!RuntimePrincipalV1Schema.safeParse(input.principal).success ||
						!isDeepStrictEqual(input.principal, binding.principal) ||
						input.agentId !== binding.scope.agentId ||
						!record(input.client) ||
						Object.keys(input.client).sort().join(",") !==
							"connectionIdentity,credential,service" ||
						!isCodexConnectionClientConfiguration({
							originalBinding: binding,
							...input.client,
						}) ||
						!isDeepStrictEqual(input.client.service, {
							serviceRef: profile.serviceRef,
							issuer: profile.issuer,
							resource: profile.resource,
						})
					)
						return undefined;
					// Canonical callback schema validates these nested values at the private lane.
					return { originalBinding: binding, ...input.client };
				} finally {
					bytes.fill(0);
				}
			} finally {
				await handle.close();
			}
		} finally {
			await directory.close();
		}
	} catch {
		return undefined;
	}
}

/** Input directory is outside every native Conversation allowlist, beneath the Host root. */
export function createIndependentConnectionClientInput(options: {
	dataDirectory: string;
	profile: ClientOptions["profile"];
	resolveOriginalBinding: (
		reference: Parameters<ClientOptions["resolveOriginalClient"]>[0],
	) => Promise<OriginalBinding>;
}): ClientOptions {
	return {
		profile: options.profile,
		resolveReadOnlyClient: async (reference, read, signal) => {
			assertRuntimeProcessProtection();
			signal.throwIfAborted();
			if (!options.profile) return undefined;
			const binding = read.assertCurrent();
			if (
				binding.scope.agentId !== reference.agentId ||
				binding.scope.conversationId !== reference.conversationId ||
				binding.scope.executionId !== reference.executionId ||
				binding.scope.sessionGeneration !== reference.sessionGeneration
			)
				return undefined;
			const input = await readIndependentInput(
				options.dataDirectory,
				options.profile,
				binding,
			);
			signal.throwIfAborted();
			const current = read.assertCurrent();
			return isDeepStrictEqual(binding, current) ? input : undefined;
		},
		resolveOriginalClient: async (reference, signal) => {
			assertRuntimeProcessProtection();
			signal.throwIfAborted();
			if (!options.profile) return undefined;
			const binding = await options.resolveOriginalBinding(reference);
			signal.throwIfAborted();
			const input = await readIndependentInput(
				options.dataDirectory,
				options.profile,
				binding,
			);
			signal.throwIfAborted();
			// A rotation/read may overlap revocation; authorize after that await as well.
			const current = await options.resolveOriginalBinding(reference);
			signal.throwIfAborted();
			if (!isDeepStrictEqual(current, binding)) return undefined;
			return input;
		},
	};
}
