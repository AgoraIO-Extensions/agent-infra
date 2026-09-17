import {
	createFileReconciliationV1,
	type FileReconciliationStorageV1,
} from "@agent-infra/platform-core";
import { PostgresFileStoreV1 } from "@agent-infra/platform-store";

export function createPlatformFileReconciliationWorkerV1(options: {
	readonly databaseUrl: string;
	readonly storage: FileReconciliationStorageV1;
	readonly batchSize: number;
	readonly orphanGraceMs: number;
}) {
	const store = new PostgresFileStoreV1(options.databaseUrl);
	try {
		const reconciliation = createFileReconciliationV1({ ...options, store });
		return { runOnce: reconciliation.runOnce, close: () => store.close() };
	} catch (error) {
		void store.close().catch(() => undefined);
		throw error;
	}
}
