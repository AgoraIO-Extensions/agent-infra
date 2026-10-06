import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

import {
	type FileRuntimeStore,
	RuntimeHostError,
	type RuntimeOriginalExecutionRef,
	type StandardMcpClientOptions,
	validateStandardMcpInput,
	validateStandardMcpMetadata,
} from "@agent-infra/agent-runtime";
import type { ApprovedConnectionConsumerTargetV1 } from "@agent-infra/contracts/connection-consumer-profile";
import { assertStandardMcpProcessProtection } from "./standard-mcp-protection.js";

function unavailable(): never {
	throw new RuntimeHostError(
		"CONNECTION_STANDARD_CLIENT_UNAVAILABLE",
		"Standard Connection installation is unavailable",
		503,
		false,
	);
}

/** Public lookup key, derived only from authenticated original binding/profile. */
export function standardMcpInstallationKey(
	principal: { kind: string; id: string },
	agentId: string,
	target: ApprovedConnectionConsumerTargetV1,
) {
	return createHash("sha256")
		.update(
			JSON.stringify([
				principal.kind,
				principal.id,
				agentId,
				target.configFingerprint,
				target.source.ref,
				target.source.revision,
			]),
		)
		.digest("hex");
}

export function standardMcpMaterialKey(
	installationKey: string,
	ref: string,
	revision: string,
) {
	return createHash("sha256")
		.update(JSON.stringify([installationKey, ref, revision]))
		.digest("hex");
}

async function protectedBytes(
	directoryPath: string,
	name: string,
	maximum: number,
) {
	if (
		!isAbsolute(directoryPath) ||
		resolve(directoryPath) !== directoryPath ||
		directoryPath === "/"
	)
		unavailable();
	const directory = await open(
		directoryPath,
		constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
	);
	try {
		const uid = process.getuid?.();
		const beforeDirectory = await directory.stat();
		if (
			uid === undefined ||
			beforeDirectory.uid !== uid ||
			(beforeDirectory.mode & 0o777) !== 0o700 ||
			(await realpath(directoryPath)) !== directoryPath
		)
			unavailable();
		// Linux opens relative to the verified directory descriptor. The portable
		// path exists only for controlled filesystem tests; production protection
		// rejects non-Linux before either metadata or material can be read.
		const path =
			process.platform === "linux"
				? join(`/proc/self/fd/${directory.fd}`, name)
				: join(directoryPath, name);
		const file = await open(
			path,
			constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
		);
		try {
			const before = await file.stat();
			if (
				!before.isFile() ||
				before.uid !== uid ||
				before.nlink !== 1 ||
				![0o400, 0o600].includes(before.mode & 0o777) ||
				before.size < 1 ||
				before.size > maximum
			)
				unavailable();
			const bytes = Buffer.alloc(before.size + 1);
			try {
				let length = 0;
				while (length < bytes.length) {
					const { bytesRead } = await file.read(
						bytes,
						length,
						bytes.length - length,
						length,
					);
					if (!bytesRead) break;
					length += bytesRead;
				}
				const after = await file.stat();
				const currentDirectory = await open(
					directoryPath,
					constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
				);
				try {
					const current = await currentDirectory.stat();
					if (
						length !== before.size ||
						before.dev !== after.dev ||
						before.ino !== after.ino ||
						before.size !== after.size ||
						before.mtimeMs !== after.mtimeMs ||
						before.ctimeMs !== after.ctimeMs ||
						after.uid !== uid ||
						after.nlink !== 1 ||
						after.mode !== before.mode ||
						current.dev !== beforeDirectory.dev ||
						current.ino !== beforeDirectory.ino ||
						current.uid !== uid ||
						current.mode !== beforeDirectory.mode ||
						(await realpath(directoryPath)) !== directoryPath
					)
						unavailable();
				} finally {
					await currentDirectory.close();
				}
				return new TextDecoder("utf-8", { fatal: true }).decode(
					bytes.subarray(0, length),
				);
			} finally {
				bytes.fill(0);
			}
		} finally {
			await file.close();
		}
	} finally {
		await directory.close();
	}
}

/** Host-only SecretRef material; neither API/Worker nor native receives this resolver. */
export async function createProtectedStandardMcpInput(options: {
	dataDirectory: string;
	target: ApprovedConnectionConsumerTargetV1;
	store: Pick<FileRuntimeStore, "resolveOriginalExecutionBinding">;
}): Promise<StandardMcpClientOptions | undefined> {
	const target = structuredClone(options.target);
	const { dataDirectory, store } = options;
	// Place Host material inside the Bridge's existing shared deny tree. Its
	// Landlock allow() rejects every external PATH/program/system directory that
	// overlaps this boundary in either direction; only each 64-hex Conversation's
	// home/workspace is allowed. This non-Conversation child is never allowed.
	const base = join(
		dataDirectory,
		"codex-driver.json.native",
		"conversations",
		"standard-mcp-input",
	);
	try {
		if (
			!isAbsolute(dataDirectory) ||
			resolve(dataDirectory) !== dataDirectory ||
			dataDirectory === "/" ||
			(await realpath(dataDirectory)) !== dataDirectory
		)
			unavailable();
		let current = dataDirectory;
		for (const part of [
			"codex-driver.json.native",
			"conversations",
			"standard-mcp-input",
		]) {
			current = join(current, part);
			let entry: Stats;
			try {
				entry = await lstat(current);
			} catch (error) {
				// Absence is deployment configuration, never a token/permission
				// fallback. Do not read material or claim Connection capability.
				if (
					error &&
					typeof error === "object" &&
					"code" in error &&
					error.code === "ENOENT"
				)
					return undefined;
				throw error;
			}
			if (!entry.isDirectory()) unavailable();
			if (
				current === base &&
				(entry.uid !== process.getuid?.() || (entry.mode & 0o777) !== 0o700)
			)
				unavailable();
		}
	} catch {
		// Invalid installed input still selects the Connection path, but cannot
		// admit business or read material. Keep Host control/recovery available.
		return { target, resolveInput: async () => unavailable() };
	}
	return {
		target,
		resolveInput: async (
			reference: RuntimeOriginalExecutionRef,
			signal: AbortSignal,
		) => {
			try {
				assertStandardMcpProcessProtection();
				signal.throwIfAborted();
				const original = await store.resolveOriginalExecutionBinding(
					reference,
					Date.now,
				);
				signal.throwIfAborted();
				assertStandardMcpProcessProtection();
				const key = standardMcpInstallationKey(
					original.principal,
					original.scope.agentId,
					target,
				);
				const metadataText = await protectedBytes(
					join(base, "bindings"),
					`${key}.json`,
					65_536,
				);
				const metadata: unknown = JSON.parse(metadataText);
				if (
					!metadata ||
					typeof metadata !== "object" ||
					Array.isArray(metadata)
				)
					unavailable();
				const entry = metadata as Record<string, unknown>;
				// Metadata is separate from the secret: wrong binding never opens a
				// material file or imports another principal/Agent's token.
				if (
					"token" in entry ||
					"scope" in entry ||
					!isDeepStrictEqual(entry.principal, original.principal) ||
					entry.agentId !== original.scope.agentId
				)
					unavailable();
				const { agentId: _agentId, ...publicInput } = entry;
				const verified = validateStandardMcpMetadata(
					{ ...publicInput, scope: original.scope },
					reference,
					target,
				);
				assertStandardMcpProcessProtection();
				const material = standardMcpMaterialKey(
					key,
					verified.credentialRef,
					verified.credentialRevision,
				);
				const token = await protectedBytes(
					join(base, "materials"),
					`${material}.token`,
					4096,
				);
				signal.throwIfAborted();
				assertStandardMcpProcessProtection();
				const current = await store.resolveOriginalExecutionBinding(
					reference,
					Date.now,
				);
				if (
					!isDeepStrictEqual(current, original) ||
					(await protectedBytes(
						join(base, "bindings"),
						`${key}.json`,
						65_536,
					)) !== metadataText
				)
					unavailable();
				return validateStandardMcpInput(
					{ ...publicInput, scope: current.scope, token },
					reference,
					target,
				);
			} catch {
				return unavailable();
			}
		},
	};
}
