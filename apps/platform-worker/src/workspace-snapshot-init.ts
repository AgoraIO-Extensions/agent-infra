import { open } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { workspaceSnapshotLimitsV1 } from "@agent-infra/platform-core";
import {
	materializeWorkspaceSnapshotV1,
	WorkspaceSnapshotMaterializationError,
} from "./workspace-snapshot-executor.js";
import type { WorkspaceSnapshotMaterializerInputV1 } from "./workspace-snapshot-materializer.js";

/** Only the platform Secret supplies this document; all destinations remain fixed by the image. */
export function parseWorkspaceSnapshotInitManifestV1(value: unknown) {
	const fail = () => {
		throw new WorkspaceSnapshotMaterializationError();
	};
	if (!value || typeof value !== "object") return fail();
	const doc = value as Record<string, unknown>;
	if (
		doc.schemaVersion !== 1 ||
		!Array.isArray(doc.snapshots) ||
		doc.snapshots.length < 1 ||
		doc.snapshots.length > 4 ||
		!Array.isArray(doc.allowedOrigins) ||
		doc.allowedOrigins.length < 1
	)
		return fail();
	const allowedOrigins = doc.allowedOrigins.map((origin) => {
		if (typeof origin !== "string") return fail();
		const url = new URL(origin);
		if (url.protocol !== "https:" || url.origin !== origin) return fail();
		return origin;
	});
	const names = new Set<string>();
	const snapshots = doc.snapshots.map((value: unknown) => {
		if (!value || typeof value !== "object") return fail();
		const s = value as Record<string, unknown>;
		for (const key of [
			"snapshotId",
			"name",
			"digest",
			"objectRef",
			"signedUrl",
			"expiresAt",
		])
			if (typeof s[key] !== "string" || !s[key]) return fail();
		if (
			typeof s.name !== "string" ||
			s.name.length > 63 ||
			!/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(s.name) ||
			names.has(s.name)
		)
			return fail();
		names.add(s.name);
		if (
			!Number.isSafeInteger(s.sizeBytes) ||
			Number(s.sizeBytes) <= 0 ||
			Number(s.sizeBytes) > workspaceSnapshotLimitsV1.maxArchiveBytes
		)
			return fail();
		if (typeof s.digest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(s.digest))
			return fail();
		const url = new URL(String(s.signedUrl));
		const expiry = Date.parse(String(s.expiresAt));
		if (
			!allowedOrigins.includes(url.origin) ||
			url.username ||
			url.password ||
			!Number.isFinite(expiry) ||
			expiry <= Date.now() ||
			expiry > Date.now() + 900_000
		)
			return fail();
		return s as unknown as WorkspaceSnapshotMaterializerInputV1;
	});
	return { snapshots, allowedOrigins };
}

export async function runWorkspaceSnapshotInitV1() {
	// Kubernetes projected Secrets use symlinks; the opened regular-file handle is bounded before parsing.
	const file = await open("/run/workspace-snapshots/manifest.json", "r");
	let value: unknown;
	try {
		const stat = await file.stat();
		if (!stat.isFile() || stat.size > 65_536)
			throw new WorkspaceSnapshotMaterializationError();
		const bytes = Buffer.alloc(65_537);
		const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
		if (bytesRead > 65_536) throw new WorkspaceSnapshotMaterializationError();
		value = JSON.parse(bytes.subarray(0, bytesRead).toString("utf8"));
	} finally {
		await file.close();
	}
	const { snapshots, allowedOrigins } =
		parseWorkspaceSnapshotInitManifestV1(value);
	const signal = AbortSignal.timeout(300_000);
	for (const snapshot of snapshots) {
		await materializeWorkspaceSnapshotV1({
			snapshot,
			allowedOrigins,
			outputDirectory: "/materialized",
			signal,
			maxArchiveBytes: workspaceSnapshotLimitsV1.maxArchiveBytes,
			maxUnpackedBytes: workspaceSnapshotLimitsV1.maxUnpackedBytes,
		});
	}
}
if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	try {
		await runWorkspaceSnapshotInitV1();
	} catch {
		process.stderr.write("WORKSPACE_SNAPSHOT_MATERIALIZATION_FAILED\n");
		process.exitCode = 1;
	}
}
