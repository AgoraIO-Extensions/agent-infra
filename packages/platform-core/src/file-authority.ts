import { randomUUID } from "node:crypto";

export interface FileScopeV1 {
	readonly actorId: string;
	readonly agentId: string;
	readonly channelId: string;
	readonly conversationId: string;
}
export interface FileDescriptorV1 {
	readonly name: string;
	readonly mediaType: string;
	readonly sizeBytes: number;
	readonly sha256: string;
}
export interface FileLimitsV1 {
	readonly revision: string;
	readonly expiresAt: string;
	readonly mediaTypes: readonly string[];
	readonly maxBytes: number;
}
export interface FileExecutionV1 {
	readonly executionId: string;
	readonly sessionGeneration: number;
	readonly grantId: string;
	readonly attachments: readonly string[];
	readonly expiresAt: string;
}
export interface FileAuthorityV1 extends FileScopeV1 {
	readonly limits: FileLimitsV1 | null;
	readonly execution: FileExecutionV1 | null;
}
/**
 * Native Skill text inputs (issue #2887) are bounded, read-only `text/plain`
 * attachments. The limits live here because FileAuthority owns the input
 * facts; admission still intersects them with the current FileLimits.
 */
export const nativeTextInputLimitV1 = Object.freeze({
	maxFiles: 4,
	maxBytes: 4096,
	mediaType: "text/plain",
} as const);
export type NativeTextInputV1 = Readonly<{
	readonly fileId: string;
	readonly sha256: string;
	readonly byteLength: number;
	readonly mediaType: "text/plain";
}>;
export type FileExecutionInputBindingV1 = Readonly<{
	readonly executionId: string;
	readonly sessionGeneration: number;
}>;
export interface FileAuthorizationPortV1 {
	authorize(
		conversationId: string,
		operation: "read" | "write",
	): Promise<FileAuthorityV1 | null>;
}
export interface FileRecordV1 extends FileScopeV1 {
	readonly fileId: string;
	readonly objectRef: string;
	readonly kind: "attachment" | "result";
	readonly idempotencyKey: string;
	readonly descriptor: FileDescriptorV1;
	readonly status:
		| "pending"
		| "available"
		| "failed"
		| "expired"
		| "deleting"
		| "deleted";
	readonly executionId: string | null;
	readonly messageId: string | null;
	readonly sessionGeneration: number | null;
	readonly objectVersion: string | null;
	readonly etag: string | null;
	readonly createdAt: string;
	readonly expiresAt: string;
	readonly updatedAt: string;
	readonly revision: number;
	/**
	 * #3226：分配结果意图时写入的规范化工作区相对路径（回答内 `sandbox:` 引用）。
	 * 其他来源为 null；旧记录与附件没有该字段，按 null 处理。
	 */
	readonly workspaceReference?: string | null;
}
/**
 * #3226：规范化的工作区相对路径：1–1024 字符，以 `/` 分隔的非空段，不含 `.`/`..` 段、
 * NUL 与反斜杠（工程 Spec §15.4.4）。
 */
export function isWorkspaceReferenceV1(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= 1024 &&
		!value.includes("\0") &&
		!value.includes("\\") &&
		value
			.split("/")
			.every((segment) => segment !== "" && segment !== "." && segment !== "..")
	);
}
export interface StoredFileObjectV1 {
	readonly sizeBytes: number;
	readonly mediaType: string;
	readonly sha256: string;
	readonly etag: string;
	readonly version: string;
}
export interface ObjectStoragePortV1 {
	inspect(
		objectRef: string,
		version?: string,
	): Promise<StoredFileObjectV1 | null>;
}
export interface FileAccessRecordV1 extends FileScopeV1 {
	readonly schemaVersion: 1;
	readonly purpose: "file_access";
	readonly issuer: string;
	readonly audience: "platform_files";
	readonly accessId: string;
	readonly fileId: string;
	readonly operation: "read" | "write";
	readonly issuedAt: string;
	readonly expiresAt: string;
	readonly maxBytes: number;
	readonly execution: {
		readonly executionId: string;
		readonly sessionGeneration: number;
		readonly grantId: string;
	} | null;
	readonly keyVersion: string;
	readonly idempotencyKey: string;
}
export interface FileExecutionStateV1 extends FileScopeV1 {
	readonly executionId: string;
	readonly sessionGeneration: number;
	readonly deliveryFence: number;
	readonly authorizationRevision: string;
	readonly status:
		| "waiting"
		| "submitted"
		| "processing"
		| "unknown"
		| "completed"
		| "failed"
		| "cancelled";
	readonly stopPending: boolean;
}
/**
 * The persisted task authorization that admitted one Execution. The boundary
 * is parsed and validated by the caller; an unreadable row is treated as
 * absent rather than trusted.
 */
export interface FileTaskAuthorizationRecordV1 {
	readonly id: string;
	readonly executionId: string;
	readonly revoked: boolean;
	readonly boundary: unknown;
}
export interface FileTransactionV1 {
	readonly conversation:
		| (FileScopeV1 & { readonly sessionGeneration: number })
		| null;
	getExecution(executionId: string): Promise<FileExecutionStateV1 | null>;
	getTaskAuthorization(
		authorizationRecordId: string,
		executionId: string,
	): Promise<FileTaskAuthorizationRecordV1 | null>;
	getIntent(actorId: string, key: string): Promise<FileRecordV1 | null>;
	getFile(fileId: string): Promise<FileRecordV1 | null>;
	putFile(file: FileRecordV1): Promise<void>;
	getAccess(accessId: string): Promise<FileAccessRecordV1 | null>;
	findAccess(
		fileId: string,
		operation: "read" | "write",
		key: string,
	): Promise<FileAccessRecordV1 | null>;
	putAccess(access: FileAccessRecordV1): Promise<void>;
}
export interface FileStoreV1 {
	transaction<T>(
		conversationId: string,
		work: (transaction: FileTransactionV1) => Promise<T>,
	): Promise<T>;
}
export class FileAuthorityError extends Error {
	constructor(
		readonly code: "denied" | "conflict" | "invalid" | "unavailable",
	) {
		super(`File operation ${code}`);
	}
}
function denied(): never {
	throw new FileAuthorityError("denied");
}
/** 仍可进行执行期文件访问的非终态执行状态（工程 Spec §15.4.2，#3307）。 */
const fileExecutionActiveStatuses: readonly string[] = [
	"submitted",
	"processing",
	"unknown",
];
function invalid(): never {
	throw new FileAuthorityError("invalid");
}
function sameScope(left: FileScopeV1, right: FileScopeV1) {
	return (
		left.actorId === right.actorId &&
		left.agentId === right.agentId &&
		left.channelId === right.channelId &&
		left.conversationId === right.conversationId
	);
}
function descriptor(input: FileDescriptorV1): FileDescriptorV1 {
	if (
		!input ||
		Object.keys(input).sort().join(",") !== "mediaType,name,sha256,sizeBytes" ||
		typeof input.name !== "string" ||
		!/^[^\p{Cc}/\\]{1,255}$/u.test(input.name) ||
		!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(input.mediaType) ||
		input.mediaType.length > 127 ||
		!Number.isSafeInteger(input.sizeBytes) ||
		input.sizeBytes < 0 ||
		!/^[a-f0-9]{64}$/.test(input.sha256)
	)
		invalid();
	return {
		name: input.name,
		mediaType: input.mediaType,
		sizeBytes: input.sizeBytes,
		sha256: input.sha256,
	};
}
function checkLimits(
	value: FileDescriptorV1,
	limits: FileLimitsV1 | null,
	now: Date,
) {
	if (
		!limits?.revision ||
		!Number.isFinite(Date.parse(limits.expiresAt)) ||
		Date.parse(limits.expiresAt) <= now.getTime() ||
		!Number.isSafeInteger(limits.maxBytes) ||
		limits.maxBytes < value.sizeBytes ||
		!limits.mediaTypes.includes(value.mediaType)
	)
		denied();
}
export function createFileAuthorityV1(options: {
	readonly store: FileStoreV1;
	readonly now?: () => Date;
	readonly intentTtlMs: number;
	readonly accessTtlMs: number;
	readonly issuer: string;
	readonly keyVersion: string;
	readonly storage: ObjectStoragePortV1;
}) {
	const now = options.now ?? (() => new Date());
	if (
		!Number.isSafeInteger(options.intentTtlMs) ||
		options.intentTtlMs < 1 ||
		!Number.isSafeInteger(options.accessTtlMs) ||
		options.accessTtlMs < 1 ||
		!options.issuer ||
		!options.keyVersion
	)
		invalid();
	async function requireExecution(
		tx: FileTransactionV1,
		authority: FileAuthorityV1,
	) {
		const grant = authority.execution;
		if (
			!grant ||
			!Number.isFinite(Date.parse(grant.expiresAt)) ||
			Date.parse(grant.expiresAt) <= now().getTime()
		)
			denied();
		const execution = await tx.getExecution(grant.executionId);
		// 工程 Spec §15.4.2：终态、取消（停止标记）、撤权、过期与代次变化拒绝。`unknown` 不是终态：
		// Worker 在调用 Runtime 之前把执行 write-ahead 为 unknown，Driver 在原生受理前读取
		// 附件时执行正处于该状态（#3307）；交换另以签名中的 delivery fence 约束本次投递。
		if (
			!execution ||
			!sameScope(execution, authority) ||
			execution.sessionGeneration !== grant.sessionGeneration ||
			tx.conversation?.sessionGeneration !== grant.sessionGeneration ||
			!fileExecutionActiveStatuses.includes(execution.status) ||
			execution.stopPending
		)
			denied();
		return execution;
	}

	async function authorizedFile(
		tx: FileTransactionV1,
		request: {
			conversationId: string;
			fileId: string;
			operation: "read" | "write";
		},
		authorization: FileAuthorizationPortV1,
	) {
		const authority = await authorization.authorize(
			request.conversationId,
			request.operation,
		);
		if (
			!authority ||
			!tx.conversation ||
			!sameScope(tx.conversation, authority)
		)
			denied();
		const file = await tx.getFile(request.fileId);
		if (!file || !sameScope(file, authority)) denied();
		if (authority.execution) {
			await requireExecution(tx, authority);
			// SPEC §15.4.1: an input attachment may bind once to a Message or to an
			// Execution, never both. Message-bound reads stay exact; an
			// Execution-only binding is accepted only for this Execution and this
			// Session generation, and only while the Grant lists the file (#2887).
			const executionOnlyBinding =
				file.executionId === authority.execution.executionId &&
				file.sessionGeneration === authority.execution.sessionGeneration;
			if (
				request.operation === "write"
					? file.kind !== "result" ||
						file.executionId !== authority.execution.executionId ||
						file.sessionGeneration !== authority.execution.sessionGeneration
					: file.kind !== "attachment" ||
						!authority.execution.attachments.includes(file.fileId) ||
						(file.messageId === null && !executionOnlyBinding)
			)
				denied();
		} else if (request.operation === "write" && file.kind !== "attachment")
			denied();
		if (request.operation === "write" || authority.execution)
			checkLimits(file.descriptor, authority.limits, now());
		return { file, authority };
	}
	async function authorizedAccess(
		tx: FileTransactionV1,
		request: {
			conversationId: string;
			fileId: string;
			operation: "read" | "write";
			accessId: string;
		},
		authorization: FileAuthorizationPortV1,
		allowCompleted = false,
	) {
		const { file, authority } = await authorizedFile(
			tx,
			request,
			authorization,
		);
		const access = await tx.getAccess(request.accessId);
		const instant = now().getTime();
		if (
			!access ||
			access.fileId !== file.fileId ||
			access.operation !== request.operation ||
			!sameScope(access, authority) ||
			instant < Date.parse(access.issuedAt) ||
			instant >= Date.parse(access.expiresAt) ||
			access.maxBytes !== file.descriptor.sizeBytes
		)
			denied();
		if (
			access.execution
				? !authority.execution ||
					access.execution.executionId !== authority.execution.executionId ||
					access.execution.sessionGeneration !==
						authority.execution.sessionGeneration ||
					access.execution.grantId !== authority.execution.grantId
				: authority.execution !== null
		)
			denied();
		if (
			request.operation === "read"
				? file.status !== "available"
				: (file.status !== "pending" &&
						!(allowCompleted && file.status === "available")) ||
					(file.status === "pending" && instant >= Date.parse(file.expiresAt))
		)
			denied();
		return { file, access };
	}

	async function createIntent(
		kind: "attachment" | "result",
		request: {
			conversationId: string;
			idempotencyKey: string;
			descriptor: FileDescriptorV1;
			workspaceReference?: string | null;
		},
		authorization: FileAuthorizationPortV1,
	) {
		const value = descriptor(request.descriptor);
		if (!/^[A-Za-z0-9._~-]{1,128}$/.test(request.idempotencyKey)) invalid();
		// #3226：只有结果意图可以携带工作区引用；省略与 null 都表示没有引用。
		const workspaceReference = request.workspaceReference ?? null;
		if (
			workspaceReference !== null &&
			(kind !== "result" || !isWorkspaceReferenceV1(workspaceReference))
		)
			invalid();
		return options.store.transaction(request.conversationId, async (tx) => {
			const authority = await authorization.authorize(
				request.conversationId,
				"write",
			);
			if (
				!authority ||
				(kind === "attachment"
					? authority.execution !== null
					: authority.execution === null) ||
				!tx.conversation ||
				!sameScope(tx.conversation, authority)
			)
				denied();
			if (authority.execution) await requireExecution(tx, authority);
			const instant = now();
			checkLimits(value, authority.limits, instant);
			const existing = await tx.getIntent(
				authority.actorId,
				request.idempotencyKey,
			);
			if (existing) {
				if (
					!sameScope(existing, authority) ||
					existing.kind !== kind ||
					existing.executionId !== (authority.execution?.executionId ?? null) ||
					existing.sessionGeneration !==
						(authority.execution?.sessionGeneration ?? null) ||
					(["name", "mediaType", "sizeBytes", "sha256"] as const).some(
						(key) => existing.descriptor[key] !== value[key],
					) ||
					(existing.workspaceReference ?? null) !== workspaceReference
				)
					throw new FileAuthorityError("conflict");
				return existing;
			}
			const file: FileRecordV1 = {
				actorId: authority.actorId,
				agentId: authority.agentId,
				channelId: authority.channelId,
				conversationId: authority.conversationId,
				fileId: randomUUID(),
				objectRef: randomUUID(),
				kind,
				idempotencyKey: request.idempotencyKey,
				descriptor: value,
				status: "pending",
				executionId: authority.execution?.executionId ?? null,
				messageId: null,
				sessionGeneration: authority.execution?.sessionGeneration ?? null,
				objectVersion: null,
				etag: null,
				createdAt: instant.toISOString(),
				expiresAt: new Date(
					instant.getTime() + options.intentTtlMs,
				).toISOString(),
				updatedAt: instant.toISOString(),
				revision: 0,
				...(kind === "result" && request.workspaceReference !== undefined
					? { workspaceReference }
					: {}),
			};
			await tx.putFile(file);
			return file;
		});
	}

	return {
		async authorizeInputs(
			conversationId: string,
			fileIds: readonly string[],
			authorization: FileAuthorizationPortV1,
		) {
			if (
				!Array.isArray(fileIds) ||
				fileIds.length > 32 ||
				new Set(fileIds).size !== fileIds.length
			)
				invalid();
			return options.store.transaction(conversationId, async (tx) => {
				const authority = await authorization.authorize(
					conversationId,
					"write",
				);
				if (
					!authority ||
					authority.execution ||
					!tx.conversation ||
					!sameScope(tx.conversation, authority)
				)
					denied();
				for (const fileId of fileIds) {
					const file = requireAvailableInput(
						await tx.getFile(fileId),
						authority,
					);
					checkLimits(file.descriptor, authority.limits, now());
				}
			});
		},
		async getLimits(
			conversationId: string,
			authorization: FileAuthorizationPortV1,
		) {
			return options.store.transaction(conversationId, async (tx) => {
				const authority = await authorization.authorize(
					conversationId,
					"write",
				);
				if (
					!authority ||
					!tx.conversation ||
					!sameScope(tx.conversation, authority) ||
					!authority.limits ||
					!Number.isFinite(Date.parse(authority.limits.expiresAt)) ||
					Date.parse(authority.limits.expiresAt) <= now().getTime()
				)
					denied();
				return authority.limits;
			});
		},
		async getFile(
			request: { conversationId: string; fileId: string },
			authorization: FileAuthorizationPortV1,
		) {
			return options.store.transaction(
				request.conversationId,
				async (tx) =>
					(
						await authorizedFile(
							tx,
							{ ...request, operation: "read" },
							authorization,
						)
					).file,
			);
		},
		async issueAccess(
			request: {
				conversationId: string;
				fileId: string;
				operation: "read" | "write";
				idempotencyKey: string;
			},
			authorization: FileAuthorizationPortV1,
		) {
			return options.store.transaction(request.conversationId, async (tx) => {
				const { file, authority } = await authorizedFile(
					tx,
					request,
					authorization,
				);
				if (!/^[A-Za-z0-9._~-]{1,128}$/.test(request.idempotencyKey)) invalid();
				const prior = await tx.findAccess(
					file.fileId,
					request.operation,
					request.idempotencyKey,
				);
				if (prior) {
					if (
						!sameScope(prior, authority) ||
						(prior.execution
							? prior.execution.executionId !==
									authority.execution?.executionId ||
								prior.execution.sessionGeneration !==
									authority.execution?.sessionGeneration ||
								prior.execution.grantId !== authority.execution?.grantId
							: authority.execution !== null)
					)
						throw new FileAuthorityError("conflict");
					return prior;
				}
				const instant = now();
				if (
					request.operation === "read"
						? file.status !== "available"
						: !["pending", "available"].includes(file.status) ||
							(file.status === "pending" &&
								instant.getTime() >= Date.parse(file.expiresAt))
				)
					denied();
				const access: FileAccessRecordV1 = {
					schemaVersion: 1,
					purpose: "file_access",
					issuer: options.issuer,
					audience: "platform_files",
					accessId: randomUUID(),
					fileId: file.fileId,
					actorId: file.actorId,
					agentId: file.agentId,
					channelId: file.channelId,
					conversationId: file.conversationId,
					operation: request.operation,
					issuedAt: instant.toISOString(),
					expiresAt: new Date(
						Math.min(
							instant.getTime() + options.accessTtlMs,
							authority.execution
								? Date.parse(authority.execution.expiresAt)
								: Number.POSITIVE_INFINITY,
							request.operation === "write" && file.status === "pending"
								? Date.parse(file.expiresAt)
								: Number.POSITIVE_INFINITY,
						),
					).toISOString(),
					maxBytes: file.descriptor.sizeBytes,
					execution: authority.execution
						? {
								executionId: authority.execution.executionId,
								sessionGeneration: authority.execution.sessionGeneration,
								grantId: authority.execution.grantId,
							}
						: null,
					keyVersion: options.keyVersion,
					idempotencyKey: request.idempotencyKey,
				};
				await tx.putAccess(access);
				return access;
			});
		},
		async authorizeAccess(
			request: {
				conversationId: string;
				fileId: string;
				operation: "read" | "write";
				accessId: string;
			},
			authorization: FileAuthorizationPortV1,
		) {
			return options.store.transaction(request.conversationId, (tx) =>
				authorizedAccess(tx, request, authorization),
			);
		},
		async complete(
			request: { conversationId: string; fileId: string; accessId: string },
			authorization: FileAuthorizationPortV1,
		) {
			return options.store.transaction(request.conversationId, async (tx) => {
				const { file } = await authorizedAccess(
					tx,
					{ ...request, operation: "write" },
					authorization,
					true,
				);
				if (file.status === "available") return file;
				let object: StoredFileObjectV1 | null;
				try {
					object = await options.storage.inspect(file.objectRef);
				} catch {
					throw new FileAuthorityError("unavailable");
				}
				if (
					!object ||
					object.sizeBytes !== file.descriptor.sizeBytes ||
					object.mediaType !== file.descriptor.mediaType ||
					object.sha256 !== file.descriptor.sha256 ||
					!object.etag ||
					!object.version
				)
					throw new FileAuthorityError("conflict");
				// Recheck current authorization after object I/O, before the visible commit.
				await authorizedAccess(
					tx,
					{ ...request, operation: "write" },
					authorization,
				);
				const confirmed: FileRecordV1 = {
					...file,
					status: "available",
					etag: object.etag,
					objectVersion: object.version,
					updatedAt: now().toISOString(),
					revision: file.revision + 1,
				};
				await tx.putFile(confirmed);
				return confirmed;
			});
		},
		createUpload: (
			request: {
				conversationId: string;
				idempotencyKey: string;
				descriptor: FileDescriptorV1;
			},
			authorization: FileAuthorizationPortV1,
		) => createIntent("attachment", request, authorization),
		createResult: (
			request: {
				conversationId: string;
				idempotencyKey: string;
				descriptor: FileDescriptorV1;
				/** #3226：回答内 `sandbox:` 引用的规范化路径；其他来源为 null 或省略。 */
				workspaceReference?: string | null;
			},
			authorization: FileAuthorizationPortV1,
		) => createIntent("result", request, authorization),
	};
}

// Called inside the event transaction, with the current execution scope read under lock.
// #3226：事件省略 `workspaceReference`（V1）与 null 等价，必须与记录中的值一致。
export function isConfirmedResultFileV1(
	file: FileRecordV1 | null,
	execution: FileScopeV1 & { executionId: string; sessionGeneration: number },
	event: {
		fileId: string;
		name: string;
		mediaType: string;
		sizeBytes: number;
		workspaceReference?: string | null;
	},
): boolean {
	return (
		!!file &&
		file.status === "available" &&
		file.kind === "result" &&
		sameScope(file, execution) &&
		file.executionId === execution.executionId &&
		file.sessionGeneration === execution.sessionGeneration &&
		file.fileId === event.fileId &&
		!!file.objectVersion &&
		!!file.etag &&
		file.descriptor.name === event.name &&
		file.descriptor.mediaType === event.mediaType &&
		file.descriptor.sizeBytes === event.sizeBytes &&
		(file.workspaceReference ?? null) === (event.workspaceReference ?? null)
	);
}

function requireAvailableInput(
	file: FileRecordV1 | null,
	scope: FileScopeV1,
): FileRecordV1 {
	if (
		!file ||
		!sameScope(file, scope) ||
		file.kind !== "attachment" ||
		file.status !== "available" ||
		!file.objectVersion ||
		!file.etag
	)
		denied();
	return file;
}

function requireUnboundInput(
	input: FileRecordV1 | null,
	scope: FileScopeV1,
): FileRecordV1 {
	const file = requireAvailableInput(input, scope);
	if (
		file.messageId !== null ||
		file.executionId !== null ||
		file.sessionGeneration !== null
	)
		denied();
	return file;
}

export function bindInputFileV1(
	input: FileRecordV1 | null,
	scope: FileScopeV1,
	binding: {
		messageId: string;
		executionId: string;
		sessionGeneration: number;
	},
	now: Date,
): FileRecordV1 {
	const file = requireUnboundInput(input, scope);
	return {
		...file,
		...binding,
		revision: file.revision + 1,
		updatedAt: now.toISOString(),
	};
}

/**
 * #3374：受理被拒或被放弃的入站消息已写入、但没有绑定任何 Message 的附件，转为 `expired` 交给
 * §15.4.3 的对账有界清理（工程 Spec §14.2.4）。只处理同一作用域内仍可用且未绑定的 attachment；
 * 已绑定、已在清理或作用域不一致的记录返回 null，保持不变。
 */
export function discardUnboundInputFileV1(
	input: FileRecordV1 | null,
	scope: FileScopeV1,
	now: Date,
): FileRecordV1 | null {
	if (
		!input ||
		!sameScope(input, scope) ||
		input.kind !== "attachment" ||
		input.status !== "available" ||
		input.messageId !== null ||
		input.executionId !== null ||
		input.sessionGeneration !== null
	)
		return null;
	return {
		...input,
		status: "expired",
		revision: input.revision + 1,
		updatedAt: now.toISOString(),
	};
}

function nativeTextInputFile(
	input: FileRecordV1 | null,
	scope: FileScopeV1,
): { readonly file: FileRecordV1; readonly facts: NativeTextInputV1 } {
	const file = requireUnboundInput(input, scope);
	if (
		file.descriptor.mediaType !== nativeTextInputLimitV1.mediaType ||
		file.descriptor.sizeBytes > nativeTextInputLimitV1.maxBytes
	)
		invalid();
	return {
		file,
		facts: Object.freeze({
			fileId: file.fileId,
			sha256: file.descriptor.sha256,
			byteLength: file.descriptor.sizeBytes,
			mediaType: nativeTextInputLimitV1.mediaType,
		}),
	};
}

/**
 * Resolves the ordered Invocation V2 attachment ids inside the admission
 * transaction. Every file must be an available, currently unbound attachment in
 * the same owner/Agent/Channel/Conversation scope, and the current FileLimits
 * intersection must allow `text/plain` and the byte length.
 */
export function resolveNativeTextInputsV1(
	inputs: readonly (FileRecordV1 | null)[],
	scope: FileScopeV1,
	limits: FileLimitsV1 | null,
	now: Date,
): readonly NativeTextInputV1[] {
	if (
		!Array.isArray(inputs) ||
		inputs.length < 1 ||
		inputs.length > nativeTextInputLimitV1.maxFiles
	)
		invalid();
	if (!limits) denied();
	const seen = new Set<string>();
	const resolved: NativeTextInputV1[] = [];
	for (const input of inputs) {
		const { file, facts } = nativeTextInputFile(input, scope);
		if (seen.has(file.fileId)) invalid();
		seen.add(file.fileId);
		checkLimits(file.descriptor, limits, now);
		resolved.push(facts);
	}
	return Object.freeze(resolved);
}

/**
 * Creates the Execution-only input binding required by SPEC §15.4.1.
 *
 * The file keeps `messageId = null`; the Execution id plus Session generation is
 * the single association. A later attempt to bind the same attachment to another
 * Execution (or to a Message) is denied by `requireUnboundInput`.
 */
export function bindNativeTextInputFileV1(
	input: FileRecordV1 | null,
	scope: FileScopeV1,
	binding: FileExecutionInputBindingV1,
	now: Date,
): FileRecordV1 {
	if (
		typeof binding.executionId !== "string" ||
		binding.executionId.length === 0 ||
		!Number.isSafeInteger(binding.sessionGeneration) ||
		binding.sessionGeneration < 1
	)
		invalid();
	const { file } = nativeTextInputFile(input, scope);
	return {
		...file,
		messageId: null,
		executionId: binding.executionId,
		sessionGeneration: binding.sessionGeneration,
		revision: file.revision + 1,
		updatedAt: now.toISOString(),
	};
}
