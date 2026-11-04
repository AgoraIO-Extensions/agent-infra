import { openPostgresWorkspaceSnapshotMaterializationReaderV1 } from "@agent-infra/platform-store";
import { createWorkspaceSnapshotResolverV1 } from "./workspace-snapshot-resolver.js";

/** Compose the Store reader and deployment-owned signer without importing SQL into Worker. */
export function createPostgresWorkspaceSnapshotResolverV1(input: {
	readonly databaseUrl: string;
	readonly createReadUrl: Parameters<
		typeof createWorkspaceSnapshotResolverV1
	>[0]["createReadUrl"];
	readonly policy: Parameters<
		typeof createWorkspaceSnapshotResolverV1
	>[0]["policy"];
	readonly allowedOrigins: readonly string[];
}) {
	const reader = openPostgresWorkspaceSnapshotMaterializationReaderV1(
		input.databaseUrl,
	);
	const resolver = createWorkspaceSnapshotResolverV1({
		policy: input.policy,
		allowedOrigins: input.allowedOrigins,
		createReadUrl: input.createReadUrl,
		read: reader.read,
	});
	return { resolver, close: reader.close };
}
