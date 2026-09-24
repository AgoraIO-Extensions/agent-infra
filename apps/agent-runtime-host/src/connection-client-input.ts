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
type ClientProfile = ClientOptions["profile"];
type AuthorizedService = ClientOptions["authorizedService"];
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

function readHttpsTarget(value: unknown, requireMcpPath: boolean) {
	if (typeof value !== "string" || value.length > 2048) {
		runtimeConfigurationInvalid();
	}
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		runtimeConfigurationInvalid();
	}
	if (
		url.protocol !== "https:" ||
		url.username ||
		url.password ||
		url.search ||
		url.hash ||
		(!requireMcpPath && value !== url.origin && value !== `${url.origin}/`) ||
		(requireMcpPath && (url.pathname !== "/mcp" || value !== url.href))
	) {
		runtimeConfigurationInvalid();
	}
	return value;
}

function parseConnectionProfile(value: unknown): ClientProfile {
	if (
		!record(value) ||
		Object.keys(value).sort().join(",") !==
			"issuer,profileRef,resource,serviceRef" ||
		typeof value.profileRef !== "string" ||
		!metadataId.test(value.profileRef) ||
		typeof value.serviceRef !== "string" ||
		!metadataId.test(value.serviceRef)
	) {
		runtimeConfigurationInvalid();
	}
	const issuer = readHttpsTarget(value.issuer, false);
	const resource = readHttpsTarget(value.resource, true);
	if (new URL(issuer).origin !== new URL(resource).origin) {
		runtimeConfigurationInvalid();
	}
	return {
		profileRef: value.profileRef,
		serviceRef: value.serviceRef,
		issuer,
		resource,
	};
}

/** Nonsecret deployment target. Independent access tokens never come from env. */
export function readConnectionClientProfile(
	value: string | undefined,
): ClientProfile | undefined {
	if (value === undefined) return undefined;
	try {
		return parseConnectionProfile(JSON.parse(value));
	} catch {
		return runtimeConfigurationInvalid();
	}
}

async function readIndependentInput(
	dataDirectory: string,
	profile: ClientProfile,
	authorizedService: AuthorizedService,
	binding: OriginalBinding,
) {
	// The private FD3 input is only supported on the Linux profile. Darwin's
	// hardening-only profile deliberately does not enable Connection credentials.
	if (process.platform !== "linux") return undefined;
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
			const uid = process.getuid?.();
			if (uid === undefined) return undefined;
			const directoryStat = await directory.stat();
			if (
				!directoryStat.isDirectory() ||
				directoryStat.uid !== uid ||
				(directoryStat.mode & 0o777) !== 0o700 ||
				(await realpath(inputDirectory)) !== inputDirectory
			)
				return undefined;
			const directoryPath = `/proc/self/fd/${directory.fd}`;
			const handle = await open(
				join(directoryPath, `${inputId}.json`),
				constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
			);
			try {
				const openedDirectory = await directory.stat();
				if (
					(await realpath(inputDirectory)) !== inputDirectory ||
					openedDirectory.dev !== directoryStat.dev ||
					openedDirectory.ino !== directoryStat.ino ||
					openedDirectory.uid !== uid ||
					(openedDirectory.mode & 0o777) !== 0o700
				)
					return undefined;
				const before = await handle.stat();
				if (
					!before.isFile() ||
					before.uid !== uid ||
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
						after.uid !== before.uid ||
						after.nlink !== before.nlink ||
						after.nlink !== 1 ||
						(after.mode & 0o777) !== (before.mode & 0o777) ||
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
						}) ||
						!isDeepStrictEqual(input.client.service, authorizedService)
					)
						return undefined;
					// The validator above is the sole boundary for the private callback
					// schema. Never log or echo the credential-bearing input.
					return structuredClone({
						originalBinding: binding,
						...input.client,
					});
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
		// Missing or malformed private input is an unavailable credential, not a
		// fallback to Owner, a stored token, or a platform service identity.
		return undefined;
	}
}

/** Input directory is outside every native Conversation allowlist, beneath the Host root. */
export function createIndependentConnectionClientInput(options: {
	dataDirectory: string;
	profile: ClientProfile;
	authorizedService: AuthorizedService;
	resolveOriginalBinding: (
		reference: Parameters<ClientOptions["resolveOriginalClient"]>[0],
	) => Promise<OriginalBinding>;
}): ClientOptions {
	const { authorizedService } = options;
	return {
		profile: options.profile,
		authorizedService,
		resolveReadOnlyClient: async (reference, read, signal) => {
			assertRuntimeProcessProtection();
			signal.throwIfAborted();
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
				authorizedService,
				binding,
			);
			signal.throwIfAborted();
			const current = read.assertCurrent();
			return isDeepStrictEqual(binding, current) ? input : undefined;
		},
		resolveOriginalClient: async (reference, signal) => {
			assertRuntimeProcessProtection();
			signal.throwIfAborted();
			const binding = await options.resolveOriginalBinding(reference);
			signal.throwIfAborted();
			const input = await readIndependentInput(
				options.dataDirectory,
				options.profile,
				authorizedService,
				binding,
			);
			signal.throwIfAborted();
			// A rotation/read may overlap revocation; authorize after that await as
			// well. No credential from an earlier binding is reused.
			const current = await options.resolveOriginalBinding(reference);
			signal.throwIfAborted();
			if (!isDeepStrictEqual(current, binding)) return undefined;
			return input;
		},
	};
}
