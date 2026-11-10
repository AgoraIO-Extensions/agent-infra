import { createPrivateKey, X509Certificate } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
	standardOAuthUnavailable as unavailable,
	validateStandardMcpToken,
} from "@agent-infra/agent-runtime";
import { OpaqueIdV1Schema } from "@agent-infra/contracts";
import {
	RuntimeOAuthConfigurationV1Schema,
	RuntimePrincipalV1Schema,
} from "@agent-infra/contracts/runtime";
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

/** Kubelet-owned read-only sources may use atomic-writer symlinks inside the mount. */
async function readSource(directory: string, name: string, maximum: number) {
	assertStandardMcpProcessProtection();
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

/** One-shot init; no Connection request, credential issuance or authorization. */
export async function provisionRuntimeOAuthFiles(options: {
	dataDirectory: string;
	privateDirectory: string;
	tlsSource: string;
	callbackSource: string;
	configurationBundle: unknown;
}) {
	assertStandardMcpProcessProtection();
	const input = bundle(options.configurationBundle);
	if (
		!isAbsolute(options.dataDirectory) ||
		resolve(options.dataDirectory) !== options.dataDirectory ||
		options.dataDirectory === "/"
	)
		unavailable();
	const cert = await readSource(options.tlsSource, "server.crt", 16384);
	const key = await readSource(options.tlsSource, "server.key", 16384);
	const callback = validateStandardMcpToken(
		await readSource(options.callbackSource, "callback.auth", 4096),
	);
	const certificate = new X509Certificate(cert);
	const hostname = new URL(input.configuration.runtimeOrigin).hostname;
	if (
		!(certificate.checkHost(hostname) || certificate.checkIP(hostname)) ||
		!certificate.checkPrivateKey(createPrivateKey(key)) ||
		Date.parse(certificate.validFrom) > Date.now() ||
		Date.parse(certificate.validTo) <= Date.now()
	)
		unavailable();
	// Prepare only the fixed Host deny-tree parents on the Session's own PVC.
	let path = dirname(options.dataDirectory);
	for (const part of [
		options.dataDirectory.slice(path.length + 1),
		"codex-driver.json.native",
		"conversations",
		"standard-mcp-oauth",
	]) {
		path = join(path, part);
		await mkdir(path, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
			if (error.code !== "EEXIST") throw error;
		});
		const opened = await openProtectedStandardMcpDirectory(path);
		await opened.close();
	}
	for (const name of ["tls", "bootstrap"]) {
		const directory = join(options.privateDirectory, name);
		await mkdir(directory, { mode: 0o700 }).catch(
			(error: NodeJS.ErrnoException) => {
				if (error.code !== "EEXIST") throw error;
			},
		);
		const opened = await openProtectedStandardMcpDirectory(directory);
		await opened.close();
	}
	const tls = join(options.privateDirectory, "tls");
	await writePrivate(tls, "server.crt", cert, 16384);
	await writePrivate(tls, "server.key", key, 16384);
	await writePrivate(tls, "callback.auth", callback, 4096);
	const bootstrap = join(options.privateDirectory, "bootstrap");
	await publishMetadata(bootstrap, "configuration.json", input.configuration, {
		immutable: true,
	});
	await publishMetadata(bootstrap, "binding.json", input, { immutable: true });
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
