import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

import {
	type FileRuntimeStore,
	type RuntimeOriginalExecutionRef,
	type StandardMcpClientOptions,
	validateStandardMcpInput,
	validateStandardMcpMetadata,
} from "@agent-infra/agent-runtime";
import type { ApprovedConnectionConsumerTargetV1 } from "@agent-infra/contracts/connection-consumer-profile";
import {
	readProtectedStandardMcpBytes,
	standardMcpInputUnavailable as unavailable,
} from "./standard-mcp-files.js";
import type { StandardMcpInstallationDelivery } from "./standard-mcp-installation.js";
import { assertStandardMcpProcessProtection } from "./standard-mcp-protection.js";

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

/** Host-only SecretRef material; neither API/Worker nor native receives this resolver. */
export async function createProtectedStandardMcpInput(options: {
	dataDirectory: string;
	target: ApprovedConnectionConsumerTargetV1;
	store: Pick<FileRuntimeStore, "resolveOriginalExecutionBinding">;
	delivery?: StandardMcpInstallationDelivery;
}): Promise<StandardMcpClientOptions | undefined> {
	const target = structuredClone(options.target);
	const { dataDirectory, store } = options;
	if (options.delivery?.status === "unavailable")
		return { target, resolveInput: async () => unavailable() };
	const allowedKeys =
		options.delivery?.status === "available"
			? new Set(options.delivery.installationKeys)
			: undefined;
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
					return allowedKeys
						? { target, resolveInput: async () => unavailable() }
						: undefined;
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
				if (allowedKeys && !allowedKeys.has(key)) unavailable();
				const metadataText = await readProtectedStandardMcpBytes(
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
				const token = await readProtectedStandardMcpBytes(
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
				signal.throwIfAborted();
				assertStandardMcpProcessProtection();
				if (!isDeepStrictEqual(current, original)) unavailable();
				const currentMetadata = await readProtectedStandardMcpBytes(
					join(base, "bindings"),
					`${key}.json`,
					65_536,
				);
				signal.throwIfAborted();
				assertStandardMcpProcessProtection();
				if (currentMetadata !== metadataText) unavailable();
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
