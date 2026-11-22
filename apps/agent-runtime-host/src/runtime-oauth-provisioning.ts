import { createPrivateKey, X509Certificate } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
	standardOAuthUnavailable as unavailable,
	validateStandardMcpToken,
} from "@agent-infra/agent-runtime";
import { OpaqueIdV1Schema } from "@agent-infra/contracts";
import {
	RuntimeOAuthBindingReadDescriptorV1Schema,
	RuntimeOAuthConfigurationV1Schema,
	RuntimePrincipalV1Schema,
} from "@agent-infra/contracts/runtime";
import { runtimeOAuthConfigurationFingerprintV1 } from "@agent-infra/contracts/runtime/oauth-installation-node";
import {
	assertProtectedStandardMcpDirectoryCurrent,
	openProtectedStandardMcpDirectory,
	protectedStandardMcpPath,
	readProtectedStandardMcpBytes,
} from "./standard-mcp-files.js";
import { publishMetadata } from "./standard-mcp-installation.js";
import { assertStandardMcpProcessProtection } from "./standard-mcp-protection.js";

function bundle(value: unknown) {
	if (!value || typeof value !== "object" || Array.isArray(value))
		unavailable();
	const v = value as Record<string, unknown>;
	if (
		Object.keys(v).sort().join(",") !==
			"agentId,configuration,principal,sandboxId,schemaVersion,sessionGeneration,sessionId" ||
		v.schemaVersion !== 1 ||
		!OpaqueIdV1Schema.safeParse(v.agentId).success ||
		!OpaqueIdV1Schema.safeParse(v.sandboxId).success ||
		!OpaqueIdV1Schema.safeParse(v.sessionId).success ||
		!Number.isSafeInteger(v.sessionGeneration) ||
		Number(v.sessionGeneration) < 1
	)
		unavailable();
	const principal = RuntimePrincipalV1Schema.parse(v.principal);
	const configuration = RuntimeOAuthConfigurationV1Schema.parse(
		v.configuration,
	);
	if (
		principal.kind !== "user" ||
		configuration.patBinding ||
		"clientRegistration" in configuration
	)
		unavailable();
	return {
		schemaVersion: 1,
		agentId: v.agentId as string,
		sessionId: v.sessionId as string,
		principal,
		sandboxId: v.sandboxId as string,
		sessionGeneration: v.sessionGeneration as number,
		configuration,
	};
}

/**
 * #3054: fixed stages of the provisioning init, reported on failure without
 * values, paths or material. Diagnostics only; every check is unchanged.
 */
export type RuntimeOAuthProvisioningStageV1 =
	| "configuration"
	| "origin"
	| "dirs"
	| "protection"
	| "source"
	| "cert"
	| "write";
type ProvisioningStageObserver = (
	stage: RuntimeOAuthProvisioningStageV1,
) => void;

/** Kubelet-owned read-only sources may use atomic-writer symlinks inside the mount. */
async function readSource(
	directory: string,
	name: string,
	maximum: number,
	onStage?: ProvisioningStageObserver,
) {
	onStage?.("protection");
	assertStandardMcpProcessProtection();
	onStage?.("source");
	const root = await realpath(directory);
	const rootBefore = await stat(root);
	const path = await realpath(join(directory, name));
	if (root !== directory || !path.startsWith(`${root}/`)) unavailable();
	const file = await open(
		path,
		constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
	);
	try {
		assertStandardMcpProcessProtection();
		const before = await file.stat();
		if (
			!before.isFile() ||
			before.nlink !== 1 ||
			![0, process.getuid?.()].includes(before.uid) ||
			(before.mode & 0o027) !== 0 ||
			before.size < 1 ||
			before.size > maximum
		)
			unavailable();
		const bytes = Buffer.alloc(before.size + 1);
		try {
			let length = 0;
			while (length < bytes.length) {
				assertStandardMcpProcessProtection();
				const next = await file.read(
					bytes,
					length,
					bytes.length - length,
					length,
				);
				assertStandardMcpProcessProtection();
				if (!next.bytesRead) break;
				length += next.bytesRead;
			}
			const after = await file.stat();
			const rootAfter = await stat(directory);
			if (
				(await realpath(directory)) !== root ||
				rootBefore.dev !== rootAfter.dev ||
				rootBefore.ino !== rootAfter.ino ||
				length !== before.size ||
				before.ino !== after.ino ||
				before.size !== after.size ||
				before.ctimeMs !== after.ctimeMs ||
				before.mtimeMs !== after.mtimeMs ||
				before.mode !== after.mode ||
				after.nlink !== 1 ||
				(await realpath(join(directory, name))) !== path
			)
				unavailable();
			return new TextDecoder("utf-8", { fatal: true }).decode(
				bytes.subarray(0, length),
			);
		} finally {
			bytes.fill(0);
		}
	} finally {
		await file.close();
	}
}

async function writePrivate(
	directory: string,
	name: string,
	text: string,
	maximum: number,
) {
	const previous = await readProtectedStandardMcpBytes(
		directory,
		name,
		maximum,
	).catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT") return undefined;
		throw error;
	});
	if (previous !== undefined) {
		if (previous !== text) unavailable();
		return;
	}
	const handle = await openProtectedStandardMcpDirectory(directory);
	try {
		const file = await open(
			protectedStandardMcpPath(handle, directory, name),
			constants.O_WRONLY |
				constants.O_CREAT |
				constants.O_EXCL |
				constants.O_NOFOLLOW,
			0o600,
		);
		try {
			assertStandardMcpProcessProtection();
			await file.writeFile(text, "utf8");
			assertStandardMcpProcessProtection();
			await file.sync();
			assertStandardMcpProcessProtection();
		} finally {
			await file.close();
		}
		await handle.sync();
		await assertProtectedStandardMcpDirectoryCurrent(directory, handle);
		if (
			(await readProtectedStandardMcpBytes(directory, name, maximum)) !== text
		)
			unavailable();
	} finally {
		await handle.close();
	}
}

/** Empty mount targets contain no credential and must exist even when OAuth is disabled. */
export async function prepareRuntimeOAuthProvisioningDirectories(options: {
	dataDirectory: string;
	privateDirectory: string;
}) {
	for (const path of [options.dataDirectory, options.privateDirectory])
		if (!isAbsolute(path) || resolve(path) !== path || path === "/")
			unavailable();
	const paths = [
		options.dataDirectory,
		join(options.dataDirectory, "codex-driver.json.native"),
		join(options.dataDirectory, "codex-driver.json.native", "conversations"),
		join(
			options.dataDirectory,
			"codex-driver.json.native",
			"conversations",
			"standard-mcp-oauth",
		),
		join(options.privateDirectory, "tls"),
		join(options.privateDirectory, "bootstrap"),
	];
	for (const path of paths) {
		await mkdir(path, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
			if (error.code !== "EEXIST") throw error;
		});
		const value = await lstat(path);
		if (
			!value.isDirectory() ||
			value.uid !== process.getuid?.() ||
			(value.mode & 0o777) !== 0o700 ||
			(await realpath(path)) !== path
		)
			unavailable();
	}
}

/** One-shot init; no Connection request, credential issuance or authorization. */
export async function provisionRuntimeOAuthFiles(options: {
	dataDirectory: string;
	privateDirectory: string;
	tlsSource: string;
	callbackSource: string;
	configurationBundle: unknown;
	registrationDescriptor?: unknown;
	registrationSource?: string;
	onStage?: ProvisioningStageObserver;
}) {
	const onStage = options.onStage;
	onStage?.("dirs");
	await prepareRuntimeOAuthProvisioningDirectories(options);
	onStage?.("protection");
	assertStandardMcpProcessProtection();
	onStage?.("configuration");
	const input = bundle(options.configurationBundle);
	if (
		(options.registrationDescriptor === undefined) !==
		(options.registrationSource === undefined)
	)
		unavailable();
	const registration =
		options.registrationDescriptor === undefined
			? undefined
			: RuntimeOAuthBindingReadDescriptorV1Schema.parse(
					options.registrationDescriptor,
				);
	if (
		registration &&
		(registration.clientId !== input.configuration.clientId ||
			registration.configurationFingerprint !==
				runtimeOAuthConfigurationFingerprintV1(input.configuration) ||
			Buffer.byteLength(JSON.stringify(registration)) > 65_536)
	)
		unavailable();
	if (
		!isAbsolute(options.dataDirectory) ||
		resolve(options.dataDirectory) !== options.dataDirectory ||
		options.dataDirectory === "/"
	)
		unavailable();
	const cert = await readSource(
		options.tlsSource,
		"server.crt",
		16384,
		onStage,
	);
	const key = await readSource(options.tlsSource, "server.key", 16384, onStage);
	const callback = validateStandardMcpToken(
		await readSource(options.callbackSource, "callback.auth", 4096, onStage),
	);
	const registrationAuth =
		registration && options.registrationSource
			? validateStandardMcpToken(
					await readSource(
						options.registrationSource,
						"registration.auth",
						4096,
						onStage,
					),
				)
			: undefined;
	if (registrationAuth === callback) unavailable();
	onStage?.("cert");
	const certificate = new X509Certificate(cert);
	const hostname = new URL(input.configuration.runtimeOrigin).hostname;
	if (
		!(certificate.checkHost(hostname) || certificate.checkIP(hostname)) ||
		!certificate.checkPrivateKey(createPrivateKey(key)) ||
		Date.parse(certificate.validFrom) > Date.now() ||
		Date.parse(certificate.validTo) <= Date.now()
	)
		unavailable();
	onStage?.("write");
	const tls = join(options.privateDirectory, "tls");
	await writePrivate(tls, "server.crt", cert, 16384);
	await writePrivate(tls, "server.key", key, 16384);
	await writePrivate(tls, "callback.auth", callback, 4096);
	if (registrationAuth)
		await writePrivate(tls, "registration.auth", registrationAuth, 4096);
	const bootstrap = join(options.privateDirectory, "bootstrap");
	await publishMetadata(bootstrap, "configuration.json", input.configuration, {
		immutable: true,
	});
	if (registration)
		await publishMetadata(bootstrap, "registration.json", registration, {
			immutable: true,
		});
	await publishMetadata(bootstrap, "binding.json", input, { immutable: true });
	onStage?.("protection");
	assertStandardMcpProcessProtection();
}

/** Copy deployment trust only. The empty receiver has no user or Consumer material. */
export async function provisionRuntimeConnectionInstallTrustV1(options: {
	dataDirectory: string;
	privateDirectory: string;
	tlsSource: string;
	callbackSource: string;
	readbackSource: string;
	runtimeOrigin: string;
	onStage?: ProvisioningStageObserver;
}) {
	const onStage = options.onStage;
	onStage?.("origin");
	const origin = new URL(options.runtimeOrigin);
	if (
		origin.protocol !== "https:" ||
		origin.href !== options.runtimeOrigin ||
		origin.pathname !== "/" ||
		!origin.port ||
		origin.username ||
		origin.password ||
		origin.search ||
		origin.hash
	)
		unavailable();
	onStage?.("dirs");
	await prepareRuntimeOAuthProvisioningDirectories(options);
	const certificate = await readSource(
		options.tlsSource,
		"server.crt",
		16_384,
		onStage,
	);
	const privateKey = await readSource(
		options.tlsSource,
		"server.key",
		16_384,
		onStage,
	);
	const callbackToken = validateStandardMcpToken(
		await readSource(options.callbackSource, "callback.auth", 4096, onStage),
	);
	const installToken = validateStandardMcpToken(
		await readSource(options.readbackSource, "install.auth", 4096, onStage),
	);
	const workerCa = await readSource(
		options.readbackSource,
		"worker-ca.crt",
		16_384,
		onStage,
	);
	onStage?.("cert");
	const leaf = new X509Certificate(certificate);
	const now = Date.now();
	if (
		!leaf.checkHost(origin.hostname) ||
		!leaf.checkPrivateKey(createPrivateKey(privateKey)) ||
		Date.parse(leaf.validFrom) > now ||
		Date.parse(leaf.validTo) <= now ||
		!new X509Certificate(workerCa).ca ||
		callbackToken === installToken
	)
		unavailable();
	onStage?.("write");
	const directory = join(options.privateDirectory, "tls");
	await writePrivate(directory, "server.crt", certificate, 16_384);
	await writePrivate(directory, "server.key", privateKey, 16_384);
	await writePrivate(directory, "callback.auth", callbackToken, 4096);
	await writePrivate(directory, "worker-ca.crt", workerCa, 16_384);
	await writePrivate(directory, "install.auth", installToken, 4096);
	onStage?.("protection");
	assertStandardMcpProcessProtection();
}

/** A provisioned bundle never changes the existing client/options contract. */
export async function validateRuntimeOAuthProvisioning(
	environment: NodeJS.ProcessEnv,
	dataDirectory: string,
) {
	const mode = environment.AGENT_INFRA_RUNTIME_CONNECTION_OAUTH_PROVISIONED;
	if (mode === undefined) return;
	if (mode !== "v1") unavailable();
	const root = join(
		dataDirectory,
		"codex-driver.json.native",
		"conversations",
		"standard-mcp-oauth",
		"bootstrap",
	);
	if (
		environment.AGENT_INFRA_RUNTIME_CONNECTION_OAUTH_FILE !==
		join(root, "configuration.json")
	)
		unavailable();
	const input = bundle(
		JSON.parse(
			await readProtectedStandardMcpBytes(root, "binding.json", 16384),
		),
	);
	const configuration = await readProtectedStandardMcpBytes(
		root,
		"configuration.json",
		8192,
	);
	if (
		!isDeepStrictEqual(JSON.parse(configuration), input.configuration) ||
		input.agentId !== environment.AGENT_INFRA_RUNTIME_AGENT_ID ||
		input.sessionId !== environment.AGENT_INFRA_RUNTIME_SESSION_ID ||
		!isDeepStrictEqual(
			input.principal,
			JSON.parse(environment.AGENT_INFRA_RUNTIME_PRINCIPAL ?? "null"),
		) ||
		input.sandboxId !== environment.AGENT_INFRA_RUNTIME_SANDBOX_ID ||
		input.sessionGeneration !==
			Number(environment.AGENT_INFRA_RUNTIME_SESSION_GENERATION)
	)
		unavailable();
	assertStandardMcpProcessProtection();
}

/** Fixed mounts of the `runtime-oauth-provision` init container. */
const provisioningInitMounts = {
	privateDirectory: "/oauth-private",
	tlsSource: "/oauth-source-tls",
	callbackSource: "/oauth-source-callback",
	readbackSource: "/oauth-source-install",
	registrationSource: "/oauth-source-registration",
};

/**
 * The provisioning init. Any failure yields one fixed line naming the last
 * stage reached; the init still exits 0 and the Host rejects incomplete
 * bootstrap while ordinary model/control startup continues (#3054).
 */
export async function runRuntimeOAuthProvisioningInitV1(
	environment: NodeJS.ProcessEnv,
	mounts: typeof provisioningInitMounts = provisioningInitMounts,
): Promise<string | undefined> {
	let stage: RuntimeOAuthProvisioningStageV1 = "configuration";
	const onStage: ProvisioningStageObserver = (next) => {
		stage = next;
	};
	try {
		if (environment.AGENT_INFRA_RUNTIME_CONNECTION_INSTALL_RECEIVER === "v1") {
			if (environment.AGENT_INFRA_RUNTIME_OAUTH_PROVISIONING !== undefined)
				throw new Error("RUNTIME_OAUTH_PROVISIONING_UNAVAILABLE");
			await provisionRuntimeConnectionInstallTrustV1({
				dataDirectory: environment.AGENT_INFRA_RUNTIME_DATA_DIR ?? "",
				privateDirectory: mounts.privateDirectory,
				tlsSource: mounts.tlsSource,
				callbackSource: mounts.callbackSource,
				readbackSource: mounts.readbackSource,
				runtimeOrigin:
					environment.AGENT_INFRA_RUNTIME_CONNECTION_INSTALL_ORIGIN ?? "",
				onStage,
			});
		} else {
			onStage("dirs");
			await prepareRuntimeOAuthProvisioningDirectories({
				dataDirectory: environment.AGENT_INFRA_RUNTIME_DATA_DIR ?? "",
				privateDirectory: mounts.privateDirectory,
			});
			onStage("configuration");
			await provisionRuntimeOAuthFiles({
				dataDirectory: environment.AGENT_INFRA_RUNTIME_DATA_DIR ?? "",
				privateDirectory: mounts.privateDirectory,
				tlsSource: mounts.tlsSource,
				callbackSource: mounts.callbackSource,
				configurationBundle: JSON.parse(
					environment.AGENT_INFRA_RUNTIME_OAUTH_PROVISIONING ?? "null",
				),
				...(environment.AGENT_INFRA_RUNTIME_OAUTH_REGISTRATION === undefined
					? {}
					: {
							registrationDescriptor: JSON.parse(
								environment.AGENT_INFRA_RUNTIME_OAUTH_REGISTRATION,
							),
							registrationSource: mounts.registrationSource,
						}),
				onStage,
			});
		}
		return undefined;
	} catch {
		return `${JSON.stringify({ code: "RUNTIME_OAUTH_PROVISIONING_UNAVAILABLE", stage })}\n`;
	}
}
