import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
	validateStandardMcpInstallationMetadata,
	validateStandardMcpToken,
} from "@agent-infra/agent-runtime";
import type { ApprovedConnectionConsumerTargetV1 } from "@agent-infra/contracts/connection-consumer-profile";
import {
	assertProtectedStandardMcpDirectoryCurrent,
	openProtectedStandardMcpDirectory,
	protectedStandardMcpPath,
	readProtectedStandardMcpBytes,
	standardMcpInputUnavailable as unavailable,
} from "./standard-mcp-files.js";
import {
	standardMcpInstallationKey,
	standardMcpMaterialKey,
} from "./standard-mcp-input.js";
import { assertStandardMcpProcessProtection } from "./standard-mcp-protection.js";

export type StandardMcpInstallationDelivery =
	| { status: "unconfigured" }
	| { status: "unavailable" }
	| { status: "available"; installationKeys: ReadonlySet<string> };

/** Nonsecret path key; source selection comes only from trusted deployment. */
export function standardMcpExportKey(ref: string, revision: string) {
	return createHash("sha256")
		.update(JSON.stringify([ref, revision]))
		.digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

export async function ensurePrivateDirectory(path: string) {
	const parentPath = dirname(path);
	const parent = await openProtectedStandardMcpDirectory(parentPath);
	try {
		await mkdir(protectedStandardMcpPath(parent, parentPath, basename(path)), {
			mode: 0o700,
		}).catch((error: NodeJS.ErrnoException) => {
			if (error.code !== "EEXIST") throw error;
		});
		const directory = await openProtectedStandardMcpDirectory(path);
		try {
			await directory.sync();
			await parent.sync();
			await assertProtectedStandardMcpDirectoryCurrent(path, directory);
			await assertProtectedStandardMcpDirectoryCurrent(parentPath, parent);
		} finally {
			await directory.close();
		}
	} finally {
		await parent.close();
	}
}

const materialLockTails = new Map<string, Promise<void>>();

export async function withProtectedStandardMcpMaterialLock<T>(
	path: string,
	operation: () => Promise<T>,
) {
	const previous = materialLockTails.get(path) ?? Promise.resolve();
	let release!: () => void;
	const current = new Promise<void>((resolve) => {
		release = resolve;
	});
	materialLockTails.set(path, current);
	await previous;
	try {
		return await operation();
	} finally {
		release();
		if (materialLockTails.get(path) === current) materialLockTails.delete(path);
	}
}

export async function publishMaterial(
	path: string,
	name: string,
	token: string,
	guard?: () => void,
) {
	return withProtectedStandardMcpMaterialLock(path, () =>
		publishMaterialUnlocked(path, name, token, guard),
	);
}

async function publishMaterialUnlocked(
	path: string,
	name: string,
	token: string,
	guard?: () => void,
) {
	const assertCurrent = () => {
		assertStandardMcpProcessProtection();
		guard?.();
	};
	assertCurrent();
	const directory = await openProtectedStandardMcpDirectory(path, guard);
	try {
		const filePath = protectedStandardMcpPath(directory, path, name);
		let created = false;
		const file = await open(
			filePath,
			constants.O_WRONLY |
				constants.O_CREAT |
				constants.O_EXCL |
				constants.O_NOFOLLOW,
			0o400,
		).then(
			(handle) => {
				created = true;
				return handle;
			},
			async (error: NodeJS.ErrnoException) => {
				if (error.code !== "EEXIST") throw error;
				if (
					(await readProtectedStandardMcpBytes(path, name, 4096, guard)) !==
					token
				)
					unavailable();
				return open(
					filePath,
					constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
				);
			},
		);
		try {
			assertCurrent();
			const stat = await file.stat();
			assertCurrent();
			if (
				!stat.isFile() ||
				stat.uid !== process.getuid?.() ||
				stat.nlink !== 1 ||
				![0o400, 0o600].includes(stat.mode & 0o777)
			)
				unavailable();
			assertCurrent();
			if (created) await file.writeFile(token, "utf8");
			assertCurrent();
			await file.sync();
			assertCurrent();
		} finally {
			await file.close();
		}
		assertCurrent();
		await directory.sync();
		assertCurrent();
		await assertProtectedStandardMcpDirectoryCurrent(path, directory, guard);
		if (
			(await readProtectedStandardMcpBytes(path, name, 4096, guard)) !== token
		)
			unavailable();
	} finally {
		await directory.close();
	}
}

async function publishMetadata(
	path: string,
	name: string,
	metadata: Record<string, unknown>,
) {
	assertStandardMcpProcessProtection();
	const directory = await openProtectedStandardMcpDirectory(path);
	const temporary = `.stage-${randomUUID()}.json`;
	const temporaryPath = protectedStandardMcpPath(directory, path, temporary);
	try {
		const previous = await readProtectedStandardMcpBytes(
			path,
			name,
			65_536,
		).catch((error: NodeJS.ErrnoException) => {
			if (error.code === "ENOENT") return undefined;
			throw error;
		});
		if (previous !== undefined) {
			const existing: unknown = JSON.parse(previous);
			if (!isRecord(existing)) unavailable();
			if (
				existing.credentialRef === metadata.credentialRef &&
				existing.credentialRevision === metadata.credentialRevision &&
				!isDeepStrictEqual(existing, metadata)
			)
				unavailable();
		}
		const file = await open(
			temporaryPath,
			constants.O_WRONLY |
				constants.O_CREAT |
				constants.O_EXCL |
				constants.O_NOFOLLOW,
			0o600,
		);
		try {
			assertStandardMcpProcessProtection();
			await file.writeFile(JSON.stringify(metadata), "utf8");
			assertStandardMcpProcessProtection();
			await file.sync();
			assertStandardMcpProcessProtection();
		} finally {
			await file.close();
		}
		assertStandardMcpProcessProtection();
		await assertProtectedStandardMcpDirectoryCurrent(path, directory);
		assertStandardMcpProcessProtection();
		await rename(
			temporaryPath,
			protectedStandardMcpPath(directory, path, name),
		);
		// A failure here can leave the new metadata visible. Caller keeps the
		// capability unavailable; restart must verify the same export/result.
		await directory.sync();
		await assertProtectedStandardMcpDirectoryCurrent(path, directory);
	} finally {
		try {
			await unlink(temporaryPath).catch((error: NodeJS.ErrnoException) => {
				if (error.code !== "ENOENT") throw error;
			});
		} finally {
			await directory.close();
		}
	}
}

/** Host startup reception only. No token, raw path or parser error escapes. */
export async function receiveProtectedStandardMcpInstallation(options: {
	dataDirectory: string;
	agentId: string;
	target: ApprovedConnectionConsumerTargetV1;
	revision: string | undefined;
}): Promise<StandardMcpInstallationDelivery> {
	if (options.revision === undefined) return { status: "unconfigured" };
	try {
		const { dataDirectory, agentId, revision } = options;
		const target = structuredClone(options.target);
		if (Buffer.byteLength(revision) > 512) unavailable();
		const selected: unknown = JSON.parse(revision);
		if (
			!Array.isArray(selected) ||
			selected.length !== 2 ||
			selected.some(
				(item) =>
					typeof item !== "string" ||
					!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(item),
			)
		)
			unavailable();
		const [ref, sourceRevision] = selected as [string, string];
		assertStandardMcpProcessProtection();
		if (
			dataDirectory === "/" ||
			(await realpath(dataDirectory)) !== dataDirectory
		)
			unavailable();
		let root = dataDirectory;
		for (const part of ["codex-driver.json.native", "conversations"]) {
			root = join(root, part);
			const directory = await openProtectedStandardMcpDirectory(root);
			await directory.close();
		}
		const exportRoot = join(root, "standard-mcp-export");
		const exportDirectory = await openProtectedStandardMcpDirectory(exportRoot);
		await exportDirectory.close();
		const source = join(exportRoot, standardMcpExportKey(ref, sourceRevision));
		const manifestText = await readProtectedStandardMcpBytes(
			source,
			"manifest.json",
			8192,
		);
		const manifest: unknown = JSON.parse(manifestText);
		if (
			!isRecord(manifest) ||
			Object.keys(manifest).sort().join(",") !==
				"configFingerprint,delivery,installationKeys,schemaVersion,source" ||
			manifest.schemaVersion !== 1 ||
			!isDeepStrictEqual(manifest.delivery, {
				ref,
				revision: sourceRevision,
			}) ||
			manifest.configFingerprint !== target.configFingerprint ||
			!isDeepStrictEqual(manifest.source, target.source) ||
			!Array.isArray(manifest.installationKeys) ||
			manifest.installationKeys.length < 1 ||
			manifest.installationKeys.length > 32 ||
			manifest.installationKeys.some(
				(key) => typeof key !== "string" || !/^[a-f0-9]{64}$/.test(key),
			) ||
			new Set(manifest.installationKeys).size !==
				manifest.installationKeys.length
		)
			unavailable();
		const keys = new Set(manifest.installationKeys as string[]);
		const destination = join(root, "standard-mcp-input");
		for (const path of [
			destination,
			join(destination, "bindings"),
			join(destination, "materials"),
		])
			await ensurePrivateDirectory(path);
		const directory = await openProtectedStandardMcpDirectory(destination);
		try {
			const lockPath = protectedStandardMcpPath(
				directory,
				destination,
				".receive.lock",
			);
			const lock = await open(
				lockPath,
				constants.O_WRONLY |
					constants.O_CREAT |
					constants.O_EXCL |
					constants.O_NOFOLLOW,
				0o600,
			);
			try {
				await lock.sync();
				await directory.sync();
				await assertProtectedStandardMcpDirectoryCurrent(
					destination,
					directory,
				);
				// Serialize only reception, not business state. A crash leaves a lock:
				// fail closed until controlled ownership/recovery, never guess by PID.
				for (const key of keys) {
					assertStandardMcpProcessProtection();
					const metadataText = await readProtectedStandardMcpBytes(
						join(source, "bindings"),
						`${key}.json`,
						65_536,
					);
					const metadata = validateStandardMcpInstallationMetadata(
						JSON.parse(metadataText),
						target,
					);
					if (
						metadata.agentId !== agentId ||
						standardMcpInstallationKey(metadata.principal, agentId, target) !==
							key
					)
						unavailable();
					assertStandardMcpProcessProtection();
					const material = standardMcpMaterialKey(
						key,
						metadata.credentialRef,
						metadata.credentialRevision,
					);
					const token = validateStandardMcpToken(
						await readProtectedStandardMcpBytes(
							join(source, "materials"),
							`${material}.token`,
							4096,
						),
					);
					assertStandardMcpProcessProtection();
					if (
						(await readProtectedStandardMcpBytes(
							join(source, "bindings"),
							`${key}.json`,
							65_536,
						)) !== metadataText ||
						(await readProtectedStandardMcpBytes(
							source,
							"manifest.json",
							8192,
						)) !== manifestText
					)
						unavailable();
					validateStandardMcpInstallationMetadata(metadata, target);
					await publishMaterial(
						join(destination, "materials"),
						`${material}.token`,
						token,
					);
					await publishMetadata(
						join(destination, "bindings"),
						`${key}.json`,
						metadata,
					);
				}
				assertStandardMcpProcessProtection();
				if (
					(await readProtectedStandardMcpBytes(
						source,
						"manifest.json",
						8192,
					)) !== manifestText
				)
					unavailable();
				await assertProtectedStandardMcpDirectoryCurrent(
					destination,
					directory,
				);
			} finally {
				try {
					const before = await lock.stat();
					const after = await lstat(lockPath);
					if (before.dev !== after.dev || before.ino !== after.ino)
						unavailable();
					await unlink(lockPath);
					await directory.sync();
				} finally {
					await lock.close();
				}
			}
		} finally {
			await directory.close();
		}
		assertStandardMcpProcessProtection();
		return { status: "available", installationKeys: keys };
	} catch {
		return { status: "unavailable" };
	}
}
