import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, unlink } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
	standardOAuthUnavailable as unavailable,
	validateStandardMcpInstallationMetadata,
	validateStandardMcpToken,
} from "@agent-infra/agent-runtime";
import type { ApprovedConnectionConsumerTargetV1 } from "@agent-infra/contracts/connection-consumer-profile";
import type {
	RuntimeOAuthAuthorizedRequestV1,
	RuntimeOAuthScopeV1,
	RuntimePrincipalV1,
} from "@agent-infra/contracts/runtime";
import {
	assertProtectedStandardMcpDirectoryCurrent,
	openProtectedStandardMcpDirectory,
	protectedStandardMcpPath,
	readProtectedStandardMcpBytes,
} from "./standard-mcp-files.js";
import {
	standardMcpInstallationKey,
	standardMcpMaterialKey,
} from "./standard-mcp-input.js";
import {
	ensurePrivateDirectory,
	publishMaterial,
	publishMetadata,
	type StandardMcpOAuthPublicationState,
	standardMcpExportKey,
} from "./standard-mcp-installation.js";

/** Consume actual-binding approval, never a planned OAuth account or local ID. */
export async function readProtectedRuntimeOAuthPublication(options: {
	dataDirectory: string;
	revision: string | undefined;
	target: ApprovedConnectionConsumerTargetV1;
	clientId: string;
	configurationFingerprint: string;
	transaction: {
		authorizationId: string;
		confirmationRevision: string;
		connectionPrincipalId?: string;
		principal: RuntimePrincipalV1;
		scope: RuntimeOAuthScopeV1;
		reference: RuntimeOAuthAuthorizedRequestV1["reference"];
	};
	assertCurrent: () => void;
}) {
	if (options.revision === undefined) return undefined;
	try {
		options.assertCurrent();
		if (options.revision.length > 512) unavailable();
		const selected: unknown = JSON.parse(options.revision);
		if (
			!Array.isArray(selected) ||
			selected.length !== 2 ||
			selected.some(
				(value) =>
					typeof value !== "string" ||
					!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value),
			)
		)
			unavailable();
		const [ref, revision] = selected as [string, string];
		const delivery = { ref, revision };
		const root = join(
			options.dataDirectory,
			"codex-driver.json.native",
			"conversations",
		);
		const receipts = join(root, "standard-mcp-oauth", "publications");
		const name = `${standardMcpExportKey(ref, revision)}.json`;
		const text = await readProtectedStandardMcpBytes(
			receipts,
			name,
			65_536,
			options.assertCurrent,
		).catch((error: NodeJS.ErrnoException) => {
			if (error.code === "ENOENT") return undefined;
			throw error;
		});
		options.assertCurrent();
		if (text === undefined) return undefined;
		const value: unknown = JSON.parse(text);
		if (!value || typeof value !== "object" || Array.isArray(value))
			unavailable();
		const receipt = value as Record<string, unknown>;
		const transaction = options.transaction;
		if (
			Object.keys(receipt).sort().join(",") !==
				"authorizationId,clientId,configurationFingerprint,confirmationRevision,connectionPrincipalId,delivery,metadata,reference,schemaVersion,scope" ||
			receipt.schemaVersion !== 1 ||
			receipt.authorizationId !== transaction.authorizationId ||
			receipt.confirmationRevision !== transaction.confirmationRevision ||
			receipt.clientId !== options.clientId ||
			receipt.configurationFingerprint !== options.configurationFingerprint ||
			!transaction.connectionPrincipalId ||
			receipt.connectionPrincipalId !== transaction.connectionPrincipalId ||
			!isDeepStrictEqual(receipt.delivery, delivery) ||
			!isDeepStrictEqual(receipt.scope, transaction.scope) ||
			!isDeepStrictEqual(receipt.reference, transaction.reference)
		)
			unavailable();
		const metadata = validateStandardMcpInstallationMetadata(
			receipt.metadata,
			options.target,
		);
		if (
			!isDeepStrictEqual(metadata.principal, transaction.principal) ||
			metadata.agentId !== transaction.scope.agentId
		)
			unavailable();
		const key = standardMcpInstallationKey(
			transaction.principal,
			metadata.agentId,
			options.target,
		);
		return {
			root,
			delivery,
			metadata,
			key,
			commit: {
				delivery,
				materialKey: standardMcpMaterialKey(
					key,
					metadata.credentialRef,
					metadata.credentialRevision,
				),
				installationKey: key,
				metadataDigest: createHash("sha256")
					.update(JSON.stringify(metadata))
					.digest("hex"),
			},
			async assertCurrent() {
				options.assertCurrent();
				const current = await readProtectedStandardMcpBytes(
					receipts,
					name,
					65_536,
					options.assertCurrent,
				);
				options.assertCurrent();
				if (current !== text || metadata.expiresAt <= Date.now()) unavailable();
			},
			guard: options.assertCurrent,
		};
	} catch {
		unavailable();
	}
}

/** Publish only access material, then metadata, then the consumable manifest. */
export async function publishProtectedRuntimeOAuthInstallation(options: {
	publication: NonNullable<
		Awaited<ReturnType<typeof readProtectedRuntimeOAuthPublication>>
	>;
	accessToken: string;
	expiresAt: number;
	transactionKey: string;
}) {
	const { publication, expiresAt } = options;
	await publication.assertCurrent();
	if (publication.metadata.expiresAt > expiresAt) unavailable();
	const token = validateStandardMcpToken(options.accessToken);
	const exportRoot = join(publication.root, "standard-mcp-export");
	await ensurePrivateDirectory(exportRoot);
	await publication.assertCurrent();
	const source = join(
		exportRoot,
		standardMcpExportKey(
			publication.delivery.ref,
			publication.delivery.revision,
		),
	);
	await ensurePrivateDirectory(source);
	await publication.assertCurrent();
	const directory = await openProtectedStandardMcpDirectory(
		source,
		publication.guard,
	);
	try {
		const lockPath = protectedStandardMcpPath(
			directory,
			source,
			".publish.lock",
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
		} finally {
			await lock.close();
		}
		await directory.sync();
		await publication.assertCurrent();
		// A failure leaves the lock; no automatic retry or partially visible export.
		for (const part of ["bindings", "materials"]) {
			await ensurePrivateDirectory(join(source, part));
			await publication.assertCurrent();
		}
		await publishMaterial(
			join(source, "materials"),
			`${standardMcpMaterialKey(publication.key, publication.metadata.credentialRef, publication.metadata.credentialRevision)}.token`,
			token,
			publication.guard,
		);
		await publication.assertCurrent();
		const publishing = { guard: publication.guard, immutable: true };
		await publishMetadata(
			join(source, "bindings"),
			`${publication.key}.json`,
			publication.metadata,
			publishing,
		);
		await publication.assertCurrent();
		await publishMetadata(
			source,
			".oauth-publication.json",
			{
				schemaVersion: 1,
				transactionKey: options.transactionKey,
				expected: publication.commit,
			},
			publishing,
		);
		await publication.assertCurrent();
		await publishMetadata(
			source,
			"manifest.json",
			{
				schemaVersion: 1,
				delivery: publication.delivery,
				configFingerprint: publication.metadata.configFingerprint,
				source: publication.metadata.source,
				installationKeys: [publication.key],
			},
			publishing,
		);
		await publication.assertCurrent();
		await assertProtectedStandardMcpDirectoryCurrent(
			source,
			directory,
			publication.guard,
		);
		// Keep the durable lock until the original transaction commit is confirmed.
		return async () => {
			await publication.assertCurrent();
			const current = await openProtectedStandardMcpDirectory(
				source,
				publication.guard,
			);
			let committed = false;
			try {
				await current.sync();
				await publication.assertCurrent();
				await assertProtectedStandardMcpDirectoryCurrent(
					source,
					current,
					publication.guard,
				);
				await unlink(
					protectedStandardMcpPath(current, source, ".publish.lock"),
				);
				// Successful unlink is the commit point. A cleanup failure may restore the
				// lock after a crash; readers then refuse it rather than replaying OAuth.
				committed = true;
				await current.sync().catch(() => undefined);
			} finally {
				if (committed) await current.close().catch(() => undefined);
				else await current.close();
			}
		};
	} finally {
		await directory.close();
	}
}

/** Erase only this transaction's owned access copies after confirmed revoke. */
export async function eraseProtectedRuntimeOAuthPublication(options: {
	dataDirectory: string;
	publication: StandardMcpOAuthPublicationState;
}) {
	const { publication } = options;
	const root = join(
		options.dataDirectory,
		"codex-driver.json.native",
		"conversations",
	);
	for (const path of [
		join(
			root,
			"standard-mcp-export",
			standardMcpExportKey(
				publication.delivery.ref,
				publication.delivery.revision,
			),
			"materials",
		),
		join(root, "standard-mcp-input", "materials"),
	]) {
		const directory = await openProtectedStandardMcpDirectory(path).catch(
			(error: NodeJS.ErrnoException) => {
				if (error.code === "ENOENT") return undefined;
				throw error;
			},
		);
		if (!directory) continue;
		try {
			const name = `${publication.materialKey}.token`;
			const present = await readProtectedStandardMcpBytes(
				path,
				name,
				4096,
			).then(
				() => true,
				(error: NodeJS.ErrnoException) => {
					if (error.code === "ENOENT") return false;
					throw error;
				},
			);
			if (present) {
				await assertProtectedStandardMcpDirectoryCurrent(path, directory);
				await unlink(protectedStandardMcpPath(directory, path, name));
				await directory.sync();
				await assertProtectedStandardMcpDirectoryCurrent(path, directory);
			}
		} finally {
			await directory.close();
		}
	}
}
