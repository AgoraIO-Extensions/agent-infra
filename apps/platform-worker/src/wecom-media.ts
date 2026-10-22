import { createHash } from "node:crypto";
import {
	createObjectContentProbeV1,
	type ObjectStorageDataV1,
} from "@agent-infra/object-storage";
import {
	createFileAuthorityV1,
	createFileLimitDeclarationReaderV1,
	type FileAuthorizationPortV1,
	type FileLimitsV1,
	type FileStoreV1,
	resolveFileLimitsV1,
	sameWecomConnectionAuthorizationFactV1,
	type WecomAuthorizationPortV1,
	type WecomMediaReferenceV1,
	type WecomMediaResolutionV1,
	type WecomMediaResolverV1,
} from "@agent-infra/platform-core";
import {
	PostgresFileLimitDeclarationStoreV1,
	PostgresFileStoreV1,
} from "@agent-infra/platform-store";
import { downloadWecomMediaV1 } from "@agent-infra/wecom/worker";

/**
 * 企微智能机器人长连接入站媒体的部署输入（工程 Spec §14.2.3，#3227）。对象存储与 Platform API
 * 文件面使用同一部署装配的 Adapter；没有这一项时 Worker 不装配 resolver，入站媒体回复不支持。
 */
export interface WecomInboundMediaDeploymentV1 {
	readonly storage: Pick<ObjectStorageDataV1, "upload" | "inspect">;
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
 * 生产 resolver：在受理事务之外有界下载并解密，按实际字节识别类型，校验该企微 Channel 的
 * FileLimits 交集，经 File Authority 写入绑定发送者、Agent、Channel 与 Conversation 的 attachment。
 *
 * - 幂等键由绑定（actor、Agent、Channel、Conversation）、稳定消息 ID 与序号派生，重投不会重复写入。
 * - 每次文件操作都重新核对当前企微授权与 FileLimits，不信任受理前的快照。
 * - 下载地址、aeskey 与媒体字节只在本次调用的内存中，不进入日志、错误或返回值。
 */
export function createWecomInboundMediaResolverV1(
	options: WecomInboundMediaDeploymentV1 & {
		readonly databaseUrl: string;
		readonly authorization: WecomAuthorizationPortV1;
		readonly now?: () => Date;
		/** 测试替身；生产使用 PostgreSQL 文件记录与 FileLimits 声明。 */
		readonly files?: FileStoreV1;
		readonly readLimits?: (scope: {
			readonly agentId: string;
			readonly channelId: string;
		}) => Promise<FileLimitsV1 | null>;
	},
): WecomMediaResolverV1 & { close(): Promise<void> } {
	if (
		typeof options.storage?.upload !== "function" ||
		typeof options.storage.inspect !== "function"
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
		? createFileLimitDeclarationReaderV1({ store: declarations })
		: undefined;
	async function currentLimits(scope: {
		readonly agentId: string;
		readonly channelId: string;
	}): Promise<FileLimitsV1 | null> {
		if (options.readLimits) return options.readLimits(scope);
		if (!readDeclarations) return null;
		// 读取器返回当前配置修订；Agent 不存在时没有修订，按未声明处理。
		const current = await readDeclarations({
			...scope,
			configurationRevision: 0,
			kind: "attachment",
		});
		return current.configurationRevision >= 1
			? resolveFileLimitsV1(current.declarations, now())
			: null;
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
	return {
		async resolve({ message, authority, conversationId, signal }) {
			const scope = {
				actorId: authority.actor.actorId,
				agentId: authority.actor.agentId,
				channelId: authority.actor.channelId,
				conversationId,
			};
			// 只把会话范围交给授权端口，下载材料不离开本次调用。
			const messageScope = {
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
					const limits = await currentLimits(scope);
					return limits ? { ...scope, execution: null, limits } : null;
				},
			};
			let limits: FileLimitsV1 | null;
			try {
				limits = await currentLimits(scope);
			} catch {
				return rejected("failed");
			}
			// 没有声明 FileLimits 时按工程 Spec §15.4.1 拒绝接收媒体。
			if (!limits) return rejected("unsupported_channel");
			const maxBytes = Math.min(limits.maxBytes, driverMaxBytes);
			const attachments: string[] = [];
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
					return rejected(now().getTime() >= expiresAt ? "expired" : "failed");
				}
				if (fetched.outcome === "too_large")
					return { outcome: "rejected", reason: "too_large", maxBytes };
				if (fetched.outcome !== "downloaded") return rejected(fetched.outcome);
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
			return { outcome: "resolved", attachments };
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
