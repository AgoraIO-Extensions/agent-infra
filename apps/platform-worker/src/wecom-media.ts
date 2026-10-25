import { createHash } from "node:crypto";
import {
	createObjectContentProbeV1,
	type ObjectStorageDataV1,
} from "@agent-infra/object-storage";
import {
	createFileAuthorityV1,
	createFileLimitDeclarationReaderV1,
	discardUnboundInputFileV1,
	FileAuthorityError,
	type FileAuthorizationPortV1,
	type FileLimitsV1,
	type FileStoreV1,
	parseCurrentTaskUserV1,
	resolveFileLimitsV1,
	sameWecomConnectionAuthorizationFactV1,
	type WecomAuthorityStatePortV1,
	type WecomAuthorizationPortV1,
	type WecomIdentityPortV1,
	type WecomMediaReferenceV1,
	type WecomMediaResolutionV1,
	type WecomMediaResolverV1,
	type WecomOutboundMediaV1,
	type WecomScopeV1,
	wecomChannelIdV1,
} from "@agent-infra/platform-core";
import {
	PostgresAgentConfigurationQueryV1,
	PostgresFileLimitDeclarationStoreV1,
	PostgresFileStoreV1,
} from "@agent-infra/platform-store";
import { downloadWecomMediaV1 } from "@agent-infra/wecom/worker";

/**
 * 企微智能机器人长连接入站媒体的部署输入（工程 Spec §14.2.3，#3227）。对象存储与 Platform API
 * 文件面使用同一部署装配的 Adapter；没有这一项时 Worker 不装配 resolver，入站媒体回复不支持。
 */
export interface WecomInboundMediaDeploymentV1 {
	/**
	 * 与 Platform API 文件面同一 bucket 与前缀的对象存储 Adapter。入站写入需要 `upload` 与 `inspect`；
	 * 同时提供 `download` 时装配长连接出站媒体（#3229），按文件记录的固定版本读取结果文件。
	 */
	readonly storage: Pick<ObjectStorageDataV1, "upload" | "inspect"> &
		Partial<Pick<ObjectStorageDataV1, "download">>;
	/** 上传意图有效期，默认 15 分钟。 */
	readonly intentTtlMs?: number;
	/** Worker 内部写入权限有效期，默认 5 分钟。 */
	readonly accessTtlMs?: number;
	/** 单个媒体的下载时限，默认 60 秒，同时不超过下载地址的剩余有效期。 */
	readonly downloadTimeoutMs?: number;
	/**
	 * 整个 Worker 进程同时下载的媒体数，默认 4，限制内存中的媒体字节。一条消息内的媒体逐个处理，
	 * 总时长受下载地址 5 分钟有效期约束，短于回复有效期。
	 */
	readonly maxConcurrentDownloads?: number;
	/**
	 * 部署批准的企微下载域名（含子域名），初始地址与每一跳重定向都必须落在其中；不提供时只要求
	 * HTTPS、不带凭据且是公网 DNS 名称。
	 */
	readonly allowedDownloadHosts?: readonly string[];
	/** 部署可替换的出站 fetch（例如代理）；默认使用全局 fetch。 */
	readonly fetch?: typeof fetch;
}

/** 工程 Spec §15.4.4 的 Driver 单文件上限；超过它的附件 Agent 也无法读取。 */
const driverMaxBytes = 50 * 1024 * 1024;

function bounded(
	value: number | undefined,
	fallback: number,
	minimum: number,
	maximum: number,
): number {
	const result = value ?? fallback;
	if (!Number.isSafeInteger(result) || result < minimum || result > maximum)
		throw new Error("WeCom inbound media configuration is invalid");
	return result;
}

/** 有界并发：等待受调用方信号约束，信号结束时放弃排队。 */
function createSlots(maximum: number) {
	let active = 0;
	const waiting: (() => void)[] = [];
	return async function run<T>(
		signal: AbortSignal,
		work: () => Promise<T>,
	): Promise<T> {
		while (active >= maximum) {
			signal.throwIfAborted();
			await new Promise<void>((resolve, reject) => {
				const onAbort = () => {
					const index = waiting.indexOf(wake);
					if (index >= 0) waiting.splice(index, 1);
					reject(signal.reason);
				};
				const wake = () => {
					signal.removeEventListener("abort", onAbort);
					resolve();
				};
				waiting.push(wake);
				signal.addEventListener("abort", onAbort, { once: true });
			});
		}
		active++;
		try {
			return await work();
		} finally {
			active--;
			waiting.shift()?.();
		}
	};
}

const extensions: Readonly<Record<string, string>> = {
	"application/pdf": "pdf",
	"application/zip": "zip",
	"image/gif": "gif",
	"image/jpeg": "jpg",
	"image/png": "png",
	"image/webp": "webp",
	"text/plain": "txt",
	"video/mp4": "mp4",
	"video/quicktime": "mov",
};

/**
 * 文件名取下载响应给出的名称（只保留 basename，去掉控制字符与路径分隔符）；没有时按类型、
 * 序号与识别出的格式生成，例如 `image-1.png`。
 */
function fileName(
	provided: string | null,
	kind: WecomMediaReferenceV1["kind"],
	ordinal: number,
	mediaType: string,
): string {
	const base = (provided ?? "")
		.split(/[/\\]/)
		.at(-1)
		?.replace(/\p{Cc}/gu, "")
		.replace(/^\.+/, "")
		.trim();
	if (base) return [...base].slice(0, 255).join("");
	const extension = extensions[mediaType];
	return `${kind}-${ordinal + 1}${extension ? `.${extension}` : ""}`;
}

function rejected(
	reason: Exclude<
		Extract<WecomMediaResolutionV1, { outcome: "rejected" }>["reason"],
		"too_large"
	>,
): WecomMediaResolutionV1 {
	return { outcome: "rejected", reason, maxBytes: null };
}

/**
 * 该企微 Channel 当前的 FileLimits 三方交集（工程 Spec §15.4.1）。读取器返回当前配置修订；
 * Agent 不存在时没有修订，按未声明处理，返回 null。给出 `configurationRevision` 时，声明
 * 必须属于这个配置修订（与 Web 上传一致），否则按过期快照拒绝。
 */
export function createWecomChannelFileLimitsReaderV1(
	store: PostgresFileLimitDeclarationStoreV1,
	now: () => Date = () => new Date(),
) {
	const read = createFileLimitDeclarationReaderV1({ store });
	return async (scope: {
		readonly agentId: string;
		readonly channelId: string;
		readonly configurationRevision?: number;
	}): Promise<FileLimitsV1 | null> => {
		const current = await read({
			agentId: scope.agentId,
			channelId: scope.channelId,
			configurationRevision: scope.configurationRevision ?? 0,
			kind: "attachment",
		});
		return current.configurationRevision >= 1 &&
			(scope.configurationRevision === undefined ||
				current.configurationRevision === scope.configurationRevision)
			? resolveFileLimitsV1(current.declarations, now())
			: null;
	};
}

/**
 * #3258：读取目标 Agent 当前是否已验证附件能力。返回能力所属的配置修订；未验证、不可见或
 * 读取期间状态变化时返回 null。
 */
export type WecomAttachmentCapabilityReaderV1 = (input: {
	readonly scope: WecomScopeV1;
	/** 已通过企微授权的发送者；当前身份解析结果必须仍是同一用户。 */
	readonly actorId: string;
}) => Promise<{ readonly configurationRevision: number } | null>;

/**
 * #3258：与 Web 上传读取同一份 Runtime 展示投影（Store `readRuntimePresentation` 的
 * `capabilities.attachments`），按发送者当前身份、当前配置修订与管理状态读取，不另设能力来源。
 */
export function createWecomAttachmentCapabilityReaderV1(input: {
	readonly configuration: Pick<
		PostgresAgentConfigurationQueryV1,
		"readRuntimePresentation"
	>;
	readonly identity: Pick<WecomIdentityPortV1, "resolveSender">;
	readonly state: WecomAuthorityStatePortV1;
}): WecomAttachmentCapabilityReaderV1 {
	return async ({ scope, actorId }) => {
		const resolved = await input.identity.resolveSender(scope);
		const actor = resolved ? parseCurrentTaskUserV1(resolved) : null;
		if (actor?.accountStatus !== "active" || actor.userId !== actorId)
			return null;
		const state = await input.state.readAuthorityState(scope.agentId);
		if (
			!state ||
			state.management.agentId !== scope.agentId ||
			state.configuration.agentId !== scope.agentId
		)
			return null;
		const runtime = await input.configuration.readRuntimePresentation({
			agentId: scope.agentId,
			actorId: actor.userId,
			organizationIds: actor.organizationIds,
			isAdministrator: false,
			accountStatus: actor.accountStatus,
			expected: {
				configurationRevision: state.configuration.revision,
				management: state.management,
			},
		});
		return runtime.outcome === "found" &&
			runtime.capabilities?.attachments === true
			? { configurationRevision: state.configuration.revision }
			: null;
	};
}

/** #3229：Worker 读取并发送已确认结果文件的进程内文件客户端。 */
export interface WecomOutboundMediaFilesV1 {
	/** 该企微 Channel 当前的 FileLimits；没有声明时为 null，按 §15.4.1 不发送媒体。 */
	limits(scope: WecomScopeV1): Promise<FileLimitsV1 | null>;
	/**
	 * 读取结果文件的固定版本：经 File Authority 按当前授权读取文件记录，核对它仍是该执行已确认的
	 * 结果文件（available、对象版本与 etag、名称、类型、大小与工作区引用一致），再按对象版本与
	 * etag 有界下载，并核对实际大小与 SHA-256。不签发 File Grant。
	 */
	read(input: {
		readonly scope: WecomScopeV1;
		readonly source: {
			readonly actorId: string;
			readonly conversationId: string;
			readonly executionId: string;
		};
		readonly file: WecomOutboundMediaV1;
		readonly revalidate: () => Promise<boolean>;
		readonly signal: AbortSignal;
	}): Promise<Uint8Array>;
	/** 在进程级并发上限内运行一次媒体发送，限制内存中同时存在的文件字节。 */
	withSlot<T>(work: () => Promise<T>): Promise<T>;
}
/** 等待发送槽位超时：此时还没有任何外部效果。 */
export class WecomOutboundMediaBusyError extends Error {
	constructor() {
		super("WeCom outbound media is busy");
	}
}

export function createWecomOutboundMediaFilesV1(options: {
	readonly storage: Pick<ObjectStorageDataV1, "download" | "inspect">;
	readonly files: FileStoreV1;
	readonly readLimits: (scope: {
		readonly agentId: string;
		readonly channelId: string;
	}) => Promise<FileLimitsV1 | null>;
	/** 整个 Worker 进程同时发送的媒体数，默认 2。 */
	readonly maxConcurrentSends?: number;
	readonly now?: () => Date;
}): WecomOutboundMediaFilesV1 {
	if (
		typeof options.storage?.download !== "function" ||
		typeof options.storage.inspect !== "function"
	)
		throw new Error("WeCom outbound media configuration is invalid");
	const now = options.now ?? (() => new Date());
	const slots = createSlots(bounded(options.maxConcurrentSends, 2, 1, 8));
	const files = createFileAuthorityV1({
		store: options.files,
		storage: options.storage,
		intentTtlMs: 60_000,
		accessTtlMs: 300_000,
		// 只读取已确认的文件记录，不签发 File Grant，也不写入访问记录。
		issuer: "platform-worker",
		keyVersion: "wecom-outbound-media",
		now,
	});
	return {
		limits: (scope) =>
			options.readLimits({
				agentId: scope.agentId,
				channelId: wecomChannelIdV1(scope),
			}),
		async read({ scope, source, file, revalidate, signal }) {
			const owner = {
				actorId: source.actorId,
				agentId: scope.agentId,
				channelId: wecomChannelIdV1(scope),
				conversationId: source.conversationId,
			};
			const port: FileAuthorizationPortV1 = {
				async authorize(requested, operation) {
					if (requested !== owner.conversationId || operation !== "read")
						return null;
					return (await revalidate())
						? { ...owner, execution: null, limits: null }
						: null;
				},
			};
			const record = await files.getFile(
				{ conversationId: owner.conversationId, fileId: file.fileId },
				port,
			);
			if (
				record.kind !== "result" ||
				record.status !== "available" ||
				record.executionId !== source.executionId ||
				!record.objectVersion ||
				!record.etag ||
				record.descriptor.name !== file.name ||
				record.descriptor.mediaType !== file.mediaType ||
				record.descriptor.sizeBytes !== file.sizeBytes ||
				(record.workspaceReference ?? null) !== file.workspaceReference
			)
				throw new FileAuthorityError("denied");
			const body = await options.storage.download({
				objectRef: record.objectRef,
				version: record.objectVersion,
				etag: record.etag,
				expiresAt: new Date(now().getTime() + 300_000).toISOString(),
				signal,
			});
			const reader = body.getReader();
			const hash = createHash("sha256");
			const chunks: Uint8Array[] = [];
			let size = 0;
			try {
				for (;;) {
					const part = await reader.read();
					if (part.done) break;
					size += part.value.byteLength;
					if (size > record.descriptor.sizeBytes)
						throw new FileAuthorityError("conflict");
					hash.update(part.value);
					chunks.push(part.value);
				}
			} finally {
				await reader.cancel().catch(() => {});
			}
			if (
				size !== record.descriptor.sizeBytes ||
				hash.digest("hex") !== record.descriptor.sha256
			)
				throw new FileAuthorityError("conflict");
			return Buffer.concat(chunks, size);
		},
		async withSlot(work) {
			const queue = AbortSignal.timeout(60_000);
			let acquired = false;
			try {
				return await slots(queue, () => {
					acquired = true;
					return work();
				});
			} catch (error) {
				if (!acquired) throw new WecomOutboundMediaBusyError();
				throw error;
			}
		},
	};
}

/**
 * #3229：装配企微媒体的文件面：入站 resolver 与（对象存储提供 `download` 时的）出站文件客户端
 * 共用同一组文件记录与 FileLimits 连接池。
 */
export function createWecomMediaV1(
	options: WecomInboundMediaDeploymentV1 & {
		readonly databaseUrl: string;
		readonly authorization: WecomAuthorizationPortV1;
		/** #3258：读取发送者当前身份与 Agent 当前状态，用于核对已验证的附件能力。 */
		readonly identity: Pick<WecomIdentityPortV1, "resolveSender">;
		readonly state: WecomAuthorityStatePortV1;
	},
) {
	const files = new PostgresFileStoreV1(options.databaseUrl);
	const declarations = new PostgresFileLimitDeclarationStoreV1(
		options.databaseUrl,
	);
	const configuration = new PostgresAgentConfigurationQueryV1({
		databaseUrl: options.databaseUrl,
	});
	const readLimits = createWecomChannelFileLimitsReaderV1(declarations);
	const inbound = createWecomInboundMediaResolverV1({
		...options,
		files,
		readLimits,
		readAttachmentCapability: createWecomAttachmentCapabilityReaderV1({
			configuration,
			identity: options.identity,
			state: options.state,
		}),
	});
	const storage = options.storage;
	const outbound =
		typeof storage.download === "function"
			? createWecomOutboundMediaFilesV1({
					storage: {
						download: storage.download.bind(storage),
						inspect: storage.inspect.bind(storage),
					},
					files,
					readLimits,
				})
			: undefined;
	return {
		inbound,
		outbound,
		async close() {
			const results = await Promise.allSettled([
				inbound.close(),
				files.close(),
				declarations.close(),
				configuration.close(),
			]);
			const failure = results.find((result) => result.status === "rejected");
			if (failure?.status === "rejected") throw failure.reason;
		},
	};
}

/**
 * 生产 resolver：在受理事务之外有界下载并解密，按实际字节识别类型，校验该企微 Channel 的
 * FileLimits 交集，经 File Authority 写入绑定发送者、Agent、Channel 与 Conversation 的 attachment。
 *
 * - 幂等键由绑定（actor、Agent、Channel、Conversation）、稳定消息 ID 与序号派生，重投不会重复写入。
 * - 每次文件操作都重新核对当前企微授权、Agent 已验证的附件能力与 FileLimits，不信任受理前的快照。
 * - 下载地址、aeskey 与媒体字节只在本次调用的内存中，不进入日志、错误或返回值。
 */
export function createWecomInboundMediaResolverV1(
	options: WecomInboundMediaDeploymentV1 & {
		readonly databaseUrl: string;
		readonly authorization: WecomAuthorizationPortV1;
		/**
		 * #3258：目标 Agent 已验证的附件能力，与 Web 上传同一读取；未验证时不下载、不调用 Agent。
		 */
		readonly readAttachmentCapability: WecomAttachmentCapabilityReaderV1;
		readonly now?: () => Date;
		/** 测试替身；生产使用 PostgreSQL 文件记录与 FileLimits 声明。 */
		readonly files?: FileStoreV1;
		readonly readLimits?: (scope: {
			readonly agentId: string;
			readonly channelId: string;
			readonly configurationRevision?: number;
		}) => Promise<FileLimitsV1 | null>;
	},
): WecomMediaResolverV1 & { close(): Promise<void> } {
	if (
		typeof options.storage?.upload !== "function" ||
		typeof options.storage.inspect !== "function" ||
		typeof options.readAttachmentCapability !== "function"
	)
		throw new Error("WeCom inbound media configuration is invalid");
	const intentTtlMs = bounded(options.intentTtlMs, 900_000, 60_000, 86_400_000);
	const accessTtlMs = bounded(options.accessTtlMs, 300_000, 10_000, 3_600_000);
	const downloadTimeoutMs = bounded(
		options.downloadTimeoutMs,
		60_000,
		1_000,
		300_000,
	);
	const slots = createSlots(bounded(options.maxConcurrentDownloads, 4, 1, 16));
	const allowedHosts = options.allowedDownloadHosts;
	if (
		allowedHosts !== undefined &&
		(!Array.isArray(allowedHosts) ||
			allowedHosts.length === 0 ||
			allowedHosts.length > 32 ||
			allowedHosts.some(
				(host) =>
					typeof host !== "string" ||
					!/^\.?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(
						host,
					),
			))
	)
		throw new Error("WeCom inbound media configuration is invalid");
	const now = options.now ?? (() => new Date());
	const fileStore =
		options.files ?? new PostgresFileStoreV1(options.databaseUrl);
	const declarations = options.readLimits
		? undefined
		: new PostgresFileLimitDeclarationStoreV1(options.databaseUrl);
	const readDeclarations = declarations
		? createWecomChannelFileLimitsReaderV1(declarations, now)
		: undefined;
	/**
	 * #3258：与 Web 上传一致，先核对目标 Agent 已验证的附件能力，再读取该能力所属配置修订下的
	 * FileLimits 交集；任何一项缺失都按不支持处理。
	 */
	async function currentLimits(
		scope: {
			readonly actorId: string;
			readonly agentId: string;
			readonly channelId: string;
		},
		messageScope: WecomScopeV1,
	): Promise<FileLimitsV1 | null> {
		const capability = await options.readAttachmentCapability({
			scope: messageScope,
			actorId: scope.actorId,
		});
		if (!capability) return null;
		const limitsScope = {
			agentId: scope.agentId,
			channelId: scope.channelId,
			configurationRevision: capability.configurationRevision,
		};
		if (options.readLimits) return options.readLimits(limitsScope);
		return readDeclarations ? readDeclarations(limitsScope) : null;
	}
	const files = createFileAuthorityV1({
		store: fileStore,
		storage: options.storage,
		intentTtlMs,
		accessTtlMs,
		// Worker 内部写入不签发 File Grant；access 记录只用于完成确认的授权核对。
		issuer: "platform-worker",
		keyVersion: "wecom-inbound-media",
		now,
	});
	/**
	 * #3374：把同一作用域内仍可用、未绑定任何 Message 的附件转为 `expired`，由 §15.4.3 的对账在
	 * 宽限期后删除对象。已绑定或已在清理中的附件保持不变。
	 */
	async function discardFiles(
		scope: {
			readonly actorId: string;
			readonly agentId: string;
			readonly channelId: string;
			readonly conversationId: string;
		},
		fileIds: readonly string[],
	) {
		if (fileIds.length === 0) return;
		await fileStore.transaction(scope.conversationId, async (tx) => {
			for (const fileId of new Set(fileIds)) {
				const discarded = discardUnboundInputFileV1(
					await tx.getFile(fileId),
					scope,
					now(),
				);
				if (discarded) await tx.putFile(discarded);
			}
		});
	}
	return {
		async resolve({ message, authority, conversationId, signal }) {
			const scope = {
				actorId: authority.actor.actorId,
				agentId: authority.actor.agentId,
				channelId: authority.actor.channelId,
				conversationId,
			};
			// 只把会话范围交给授权端口，下载材料不离开本次调用。
			const messageScope: WecomScopeV1 = {
				agentId: message.agentId,
				bindingReference: message.bindingReference,
				kind: message.kind,
				senderId: message.senderId,
				peerId: message.peerId,
				conversationType: message.conversationType,
				threadId: message.threadId,
			};
			const port: FileAuthorizationPortV1 = {
				async authorize(requested, operation) {
					if (requested !== conversationId || operation !== "write")
						return null;
					const current = await options.authorization.authorize(
						messageScope,
						"use",
						authority.actor.taskBoundary,
						message.providerId,
					);
					if (
						current.outcome !== "allowed" ||
						current.authority.actor.actorId !== scope.actorId ||
						current.authority.actor.agentId !== scope.agentId ||
						current.authority.actor.channelId !== scope.channelId ||
						current.authority.channelRevision !== authority.channelRevision ||
						!sameWecomConnectionAuthorizationFactV1(
							current.authority.connectionAuthorizationFact,
							authority.connectionAuthorizationFact,
						)
					)
						return null;
					const limits = await currentLimits(scope, messageScope);
					return limits ? { ...scope, execution: null, limits } : null;
				},
			};
			let limits: FileLimitsV1 | null;
			try {
				limits = await currentLimits(scope, messageScope);
			} catch {
				return rejected("failed");
			}
			// Agent 未验证附件能力或没有声明 FileLimits 时，按工程 Spec §14.2.3 与 §15.4.1
			// 拒绝接收媒体：不下载、不调用 Agent。
			if (!limits) return rejected("unsupported_channel");
			const maxBytes = Math.min(limits.maxBytes, driverMaxBytes);
			const attachments: string[] = [];
			let resolved = false;
			try {
				// 逐个处理，内存中同一时刻只保留本消息一个媒体的字节；跨消息的并发由 slots 限制。
				for (const [ordinal, media] of (message.media ?? []).entries()) {
					const download = media.download;
					if (!download) return rejected("unsupported_channel");
					const expiresAt = Date.parse(download.expiresAt);
					const remaining = expiresAt - now().getTime();
					if (!Number.isFinite(remaining) || remaining <= 0)
						return rejected("expired");
					const queue = AbortSignal.timeout(remaining);
					let fetched: Awaited<ReturnType<typeof downloadWecomMediaV1>>;
					try {
						fetched = await slots(
							signal ? AbortSignal.any([signal, queue]) : queue,
							() =>
								downloadWecomMediaV1({
									download,
									maxBytes,
									timeoutMs: downloadTimeoutMs,
									now: () => now().getTime(),
									...(allowedHosts ? { allowedHosts } : {}),
									...(options.fetch ? { fetch: options.fetch } : {}),
									...(signal ? { signal } : {}),
								}),
						);
					} catch {
						return rejected(
							now().getTime() >= expiresAt ? "expired" : "failed",
						);
					}
					if (fetched.outcome === "too_large")
						return { outcome: "rejected", reason: "too_large", maxBytes };
					if (fetched.outcome !== "downloaded")
						return rejected(fetched.outcome);
					const bytes = fetched.bytes;
					let probed: { sizeBytes: number; mediaType: string; sha256: string };
					try {
						const probe = createObjectContentProbeV1(maxBytes);
						probe.write(bytes);
						probed = await probe.finish();
					} catch {
						// 无法按实际字节确认格式时不提供任意二进制回退（工程 Spec §15.4.1）。
						return rejected("unsupported_type");
					}
					if (!limits.mediaTypes.includes(probed.mediaType))
						return rejected("unsupported_type");
					const idempotencyKey = `wecom-${createHash("sha256")
						.update(
							JSON.stringify([
								scope.actorId,
								scope.agentId,
								scope.channelId,
								scope.conversationId,
								message.providerId,
								message.eventId,
								ordinal,
							]),
						)
						.digest("hex")}`;
					try {
						const file = await files.createUpload(
							{
								conversationId,
								idempotencyKey,
								descriptor: {
									name: fileName(
										fetched.filename ?? media.name,
										media.kind,
										ordinal,
										probed.mediaType,
									),
									mediaType: probed.mediaType,
									sizeBytes: probed.sizeBytes,
									sha256: probed.sha256,
								},
							},
							port,
						);
						if (file.status !== "available") {
							const access = await files.issueAccess(
								{
									conversationId,
									fileId: file.fileId,
									operation: "write",
									idempotencyKey,
								},
								port,
							);
							await options.storage.upload({
								objectRef: file.objectRef,
								descriptor: file.descriptor,
								expiresAt: access.expiresAt,
								body: new Blob([bytes]).stream(),
								...(signal ? { signal } : {}),
							});
							const confirmed = await files.complete(
								{
									conversationId,
									fileId: file.fileId,
									accessId: access.accessId,
								},
								port,
							);
							if (confirmed.status !== "available") return rejected("failed");
						}
						attachments.push(file.fileId);
					} catch {
						return rejected("failed");
					}
				}
				resolved = true;
				return { outcome: "resolved", attachments };
			} finally {
				// #3374：前面的媒体已写入、后面的媒体被拒或出错时，已写入的附件不会绑定任何 Message，
				// 交给文件对账清理（工程 Spec §14.2.4）。
				if (!resolved) await discardFiles(scope, attachments).catch(() => {});
			}
		},
		/** #3374：受理被拒或会话变化后，把仍未绑定的附件交给文件对账清理。 */
		async discard({ authority, conversationId, attachments }) {
			await discardFiles(
				{
					actorId: authority.actor.actorId,
					agentId: authority.actor.agentId,
					channelId: authority.actor.channelId,
					conversationId,
				},
				attachments,
			);
		},
		async close() {
			const results = await Promise.allSettled([
				options.files
					? Promise.resolve()
					: (fileStore as PostgresFileStoreV1).close(),
				declarations?.close(),
			]);
			const failure = results.find((result) => result.status === "rejected");
			if (failure?.status === "rejected") throw failure.reason;
		},
	};
}
