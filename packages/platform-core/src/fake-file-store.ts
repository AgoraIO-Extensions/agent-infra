import type {
	FileAccessRecordV1,
	FileExecutionStateV1,
	FileRecordV1,
	FileScopeV1,
	FileStoreV1,
	FileTransactionV1,
} from "./file-authority.js";

export class FakeFileStoreV1 implements FileStoreV1 {
	private cursor: string | null = null;
	private reconciling = false;
	async expiredIntents(now: string, limit: number) {
		return [...this.files.values()]
			.filter(
				(file) =>
					file.status === "pending" &&
					Date.parse(file.expiresAt) <= Date.parse(now),
			)
			.slice(0, limit)
			.map((file) => ({
				conversationId: file.conversationId,
				fileId: file.fileId,
			}));
	}
	async findObject(objectRef: string) {
		const file = [...this.files.values()].find(
			(file) => file.objectRef === objectRef,
		);
		return file
			? { conversationId: file.conversationId, fileId: file.fileId }
			: null;
	}
	async checkpoint(work: (cursor: string | null) => Promise<string | null>) {
		if (this.reconciling) return false;
		this.reconciling = true;
		try {
			this.cursor = await work(this.cursor);
			return true;
		} finally {
			this.reconciling = false;
		}
	}

	private conversations = new Map<
		string,
		FileScopeV1 & { sessionGeneration: number }
	>();
	private executions = new Map<string, FileExecutionStateV1>();
	seedExecution(value: FileExecutionStateV1) {
		this.executions.set(value.executionId, structuredClone(value));
	}
	private files = new Map<string, FileRecordV1>();
	private accesses = new Map<string, FileAccessRecordV1>();
	private tail: Promise<unknown> = Promise.resolve();
	seedConversation(scope: FileScopeV1, sessionGeneration = 1) {
		this.conversations.set(
			scope.conversationId,
			structuredClone({ ...scope, sessionGeneration }),
		);
	}
	transaction<T>(
		conversationId: string,
		work: (tx: FileTransactionV1) => Promise<T>,
	): Promise<T> {
		const run = this.tail.then(async () => {
			const files = structuredClone(this.files);
			const accesses = structuredClone(this.accesses);
			const result = await work({
				conversation: structuredClone(
					this.conversations.get(conversationId) ?? null,
				),
				getExecution: async (id) =>
					structuredClone(this.executions.get(id) ?? null),
				getIntent: async (actorId, key) =>
					structuredClone(
						[...files.values()].find(
							(file) => file.actorId === actorId && file.idempotencyKey === key,
						) ?? null,
					),
				getFile: async (fileId) => structuredClone(files.get(fileId) ?? null),
				putFile: async (file) => {
					files.set(file.fileId, structuredClone(file));
				},
				findAccess: async (fileId, operation, key) =>
					structuredClone(
						[...accesses.values()].find(
							(access) =>
								access.fileId === fileId &&
								access.operation === operation &&
								access.idempotencyKey === key,
						) ?? null,
					),
				getAccess: async (id) => structuredClone(accesses.get(id) ?? null),
				putAccess: async (access) => {
					accesses.set(access.accessId, structuredClone(access));
				},
			});
			this.files = files;
			this.accesses = accesses;
			return result;
		});
		this.tail = run.catch(() => undefined);
		return run;
	}
}
