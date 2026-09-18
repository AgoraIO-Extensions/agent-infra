import { createHash, createPublicKey, verify } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { FileRuntimeStore } from "@agent-infra/agent-runtime";
import {
	RuntimeLegacyPrincipalEnvelopeV1Schema,
	RuntimeLegacyPrincipalManifestV1Schema,
	type WorkloadReadinessBindingV1,
	WorkloadReadinessBindingV1Schema,
} from "@agent-infra/contracts/runtime";

export class RuntimeLegacyMigrationError extends Error {
	constructor() {
		super("RUNTIME_LEGACY_MIGRATION_INVALID");
	}
}

function fail(): never {
	throw new RuntimeLegacyMigrationError();
}

/**
 * Both files must be mounted by deployment bootstrap outside the Agent writable data
 * directory. Public-key provisioning is a trust-root operation, not caller input.
 * Use regular file mounts (for Kubernetes, subPath) rather than writable symlink targets.
 */
async function readMountedFile(
	path: string,
	dataDirectory: string,
	maximumBytes: number,
) {
	if (!isAbsolute(path) || resolve(path) !== path) fail();
	const [target, dataRoot] = await Promise.all([
		realpath(path),
		realpath(dataDirectory),
	]);
	const withinData = relative(dataRoot, target);
	if (
		withinData === "" ||
		(!isAbsolute(withinData) &&
			withinData !== ".." &&
			!withinData.startsWith("../"))
	)
		fail();
	const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		// Re-resolve and compare the path after opening. Parsing always uses the
		// already-open descriptor, so a later replacement cannot change the bytes.
		const openedTarget = await realpath(path);
		const pathInfo = await lstat(path);
		const info = await handle.stat();
		if (
			openedTarget !== target ||
			pathInfo.dev !== info.dev ||
			pathInfo.ino !== info.ino ||
			!info.isFile() ||
			info.size === 0 ||
			info.size > maximumBytes ||
			(info.mode & 0o022) !== 0
		)
			fail();
		const bytes = Buffer.alloc(maximumBytes + 1);
		let length = 0;
		while (length < bytes.length) {
			const read = await handle.read(
				bytes,
				length,
				bytes.length - length,
				null,
			);
			if (read.bytesRead === 0) break;
			length += read.bytesRead;
		}
		if (length === 0 || length > maximumBytes) fail();
		return bytes.subarray(0, length);
	} finally {
		await handle.close();
	}
}

/**
 * Read and authenticate a deployment-owned historical producer mapping before opening
 * the Host/Driver. The signing authority must first verify producer provenance and the
 * committed Platform migration audit for EVERY old submit in this Session. A current
 * role lookup, arbitrary actor_id, or unsigned JSON is never sufficient.
 *
 * This artifact establishes historical Session ownership only. It is not a business,
 * control or Connection Grant. Its content-addressed migration id makes replay exact;
 * actual operations still require their separately issued and current Runtime Grant.
 */
export async function readRuntimeLegacyMigrationV1(input: {
	environment: NodeJS.ProcessEnv;
	expectedIssuer: string;
	binding: WorkloadReadinessBindingV1 | undefined;
	dataDirectory: string;
}) {
	try {
		const paths = [
			input.environment.AGENT_INFRA_RUNTIME_LEGACY_MIGRATION_FILE,
			input.environment.AGENT_INFRA_RUNTIME_LEGACY_MIGRATION_PUBLIC_KEY_FILE,
			input.environment.AGENT_INFRA_RUNTIME_LEGACY_MIGRATION_KEY_ID,
		];
		if (paths.every((value) => value === undefined)) return undefined;
		const [manifestPath, publicKeyPath, keyId] = paths;
		if (!manifestPath || !publicKeyPath || !keyId || !input.binding) fail();
		const binding = WorkloadReadinessBindingV1Schema.parse(input.binding);
		const [envelopeBytes, publicKeyBytes] = await Promise.all([
			readMountedFile(manifestPath, input.dataDirectory, 256_000),
			readMountedFile(publicKeyPath, input.dataDirectory, 8192),
		]);
		const publicKey = createPublicKey(publicKeyBytes);
		if (publicKey.asymmetricKeyType !== "ed25519") fail();
		const envelope = RuntimeLegacyPrincipalEnvelopeV1Schema.parse(
			JSON.parse(envelopeBytes.toString("utf8")),
		);
		const payload = Buffer.from(envelope.payload, "base64url");
		const signature = Buffer.from(envelope.signature, "base64url");
		if (
			payload.toString("base64url") !== envelope.payload ||
			signature.toString("base64url") !== envelope.signature ||
			!verify(null, payload, publicKey, signature)
		)
			fail();
		const manifest = RuntimeLegacyPrincipalManifestV1Schema.parse(
			JSON.parse(payload.toString("utf8")),
		);
		if (
			manifest.issuer !== input.expectedIssuer ||
			manifest.keyId !== keyId ||
			!isDeepStrictEqual(manifest.deployment, binding) ||
			manifest.principal.kind !== "user" ||
			new Set(manifest.executions.map((item) => item.executionId)).size !==
				manifest.executions.length ||
			new Set(manifest.executions.map((item) => item.migrationRecordId))
				.size !== manifest.executions.length
		)
			fail();
		// This is a new migration-evidence digest, never a recomputed operation digest.
		const migrationId = `legacy-principal-v1:${createHash("sha256").update(payload).digest("hex")}`;
		const proof = {
			migrationId,
			hostSessionRef: manifest.hostSessionRef,
			agentId: binding.agentId,
			conversationId: manifest.conversationId,
			sessionGeneration: manifest.sessionGeneration,
			principal: manifest.principal,
			channelId: manifest.channelId,
			executions: manifest.executions.map(
				({ executionId, turnId, originalOperationDigest }) => ({
					executionId,
					turnId,
					originalOperationDigest,
				}),
			),
		};
		return {
			/** Single Session update remains atomic in the existing durable Store. */
			async apply(store: Pick<FileRuntimeStore, "migrateLegacyPrincipal">) {
				try {
					await store.migrateLegacyPrincipal(structuredClone(proof));
				} catch {
					fail();
				}
			},
		};
	} catch {
		fail();
	}
}
