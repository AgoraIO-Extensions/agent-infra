/**
 * #3225：附件物化到会话 Sandbox 工作区（工程 Spec §15.4.4，Runtime HLD 8.5.5，ADR-0032 决策 1）。
 *
 * 四个标准模板共用：Driver 只经 FileBridge 的 `readInput` 读取本次 Grant 精确列出的附件，
 * 写入当前 Conversation 工作区的 `.agent-infra/attachments/<ref>/<name>`，并在原生用户输入
 * 之后追加平台生成的附件清单。工作区副本不是权威数据：内容一致时复用，被改写或删除时在
 * 同一目录写临时文件后 rename 恢复。物化中的任何失败都经 Driver 提供的 `invalid` 转为
 * Driver 自己的受限错误，文件系统错误（其消息含 Host 路径）不向外传播；FileBridge 自身的
 * 拒绝原样传播。本模块不写日志、事件或持久状态。
 */
import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
	type FileHandle,
	lstat,
	mkdir,
	open,
	realpath,
	rename,
	unlink,
} from "node:fs/promises";
import { isAbsolute, join, posix, relative, sep } from "node:path";
import type { RuntimeFileInputV1 } from "./runtime-file-bridge.js";

/** Driver 自身的单文件上限（沿用 50 MiB）；FileLimits 交集由平台在读取交换时核对。 */
export const SANDBOX_ATTACHMENT_MAX_BYTES_V1 = 50 * 1024 * 1024;
/** Driver 自身的单条消息附件数上限。 */
export const SANDBOX_ATTACHMENT_MAX_COUNT_V1 = 32;
/** 平台目录：工作区相对路径的固定前缀。 */
export const SANDBOX_ATTACHMENT_DIRECTORY_V1 = ".agent-infra/attachments";
/**
 * 各 Runtime 原生图片输入接受的类型。它只决定是否“另外”作为原生图片交给模型；
 * 可接受的附件类型以 FileLimits 交集为准，不再由该集合限制。
 */
export const SANDBOX_ATTACHMENT_NATIVE_IMAGE_TYPES_V1: ReadonlySet<string> =
	new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

const nameMaximumBytes = 255;
const extensionMaximumBytes = 32;
const cancelTimeoutMs = 1_000;
const readChunkBytes = 64 * 1024;
const digestPattern = /^[a-f0-9]{64}$/;

/** 一个已物化的附件。 */
export interface SandboxAttachmentV1 {
	readonly name: string;
	readonly mediaType: string;
	readonly sizeBytes: number;
	/** 工作区相对路径（POSIX 分隔符），只进入原生输入的附件清单。 */
	readonly workspacePath: string;
	/**
	 * 工作区内文件的绝对路径，只交给原生图片输入（Codex `localImage`）；不进入持久状态、
	 * 事件、日志或清单。
	 */
	readonly path: string;
	/** 原生图片输入所需的已核对字节；只在调用方要求且类型属于原生图片时提供。 */
	readonly imageBytes?: Uint8Array;
}

/** 物化内部的拒绝；在公共入口统一转为 Driver 的 `invalid()`。 */
class SandboxAttachmentRejected extends Error {
	constructor() {
		super("RUNTIME_FILE_INPUT_UNAVAILABLE");
	}
}

function rejected(): never {
	throw new SandboxAttachmentRejected();
}

function errorCode(error: unknown) {
	return (error as NodeJS.ErrnoException | undefined)?.code;
}

/** `<ref>`：fileId 的 SHA-256 前 16 位十六进制。重试与重新生成得到同一目录。 */
export function sandboxAttachmentRefV1(fileId: string): string {
	return createHash("sha256").update(fileId).digest("hex").slice(0, 16);
}

const knownExtensions: Readonly<Record<string, string>> = {
	"application/json": "json",
	"application/octet-stream": "bin",
	"application/pdf": "pdf",
	"application/zip": "zip",
	"image/gif": "gif",
	"image/jpeg": "jpg",
	"image/png": "png",
	"image/webp": "webp",
	"text/csv": "csv",
	"text/markdown": "md",
	"text/plain": "txt",
};

/** 由媒体类型推导的回退名，只用于清洗后为空的名称。 */
function fallbackName(mediaType: string) {
	const subtype = (mediaType.split("/")[1] ?? "")
		.replace(/[^a-z0-9]+/g, "")
		.slice(0, 16);
	return `attachment.${knownExtensions[mediaType] ?? (subtype || "bin")}`;
}

/** 按 UTF-8 字节截断，尽量保留扩展名，不切开代码点。 */
function truncateUtf8(value: string, maximum: number) {
	if (Buffer.byteLength(value) <= maximum) return value;
	const dot = value.lastIndexOf(".");
	const extension =
		dot > 0 && Buffer.byteLength(value.slice(dot)) <= extensionMaximumBytes
			? value.slice(dot)
			: "";
	const budget = maximum - Buffer.byteLength(extension);
	let stem = "";
	let bytes = 0;
	for (const character of value.slice(0, value.length - extension.length)) {
		const size = Buffer.byteLength(character);
		if (bytes + size > budget) break;
		stem += character;
		bytes += size;
	}
	return `${stem}${extension}`;
}

/**
 * `<name>`：只保留 basename，去掉控制字符、路径分隔符和开头的点，不超过 255 字节；
 * 清洗后为空时回退为由媒体类型推导的安全名。
 */
export function sandboxAttachmentNameV1(
	name: string,
	mediaType: string,
): string {
	const base = name.split(/[\\/]/u).at(-1) ?? "";
	const cleaned = base
		// 孤立代理项写入文件名时会被替换，先替换才能按实际字节计长。
		.replace(
			/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
			"\uFFFD",
		)
		.replace(/[\p{Cc}\\/]/gu, "")
		.replace(/^\.+/u, "");
	return truncateUtf8(cleaned, nameMaximumBytes) || fallbackName(mediaType);
}

/**
 * 平台生成的附件清单：每个附件一行，列出名称、媒体类型、字节数和工作区相对路径。
 * 不含 fileId、对象引用或 Host 路径；名称与路径以 JSON 字符串给出，避免与格式混淆。
 * 与 `SANDBOX_FILE_INSTRUCTIONS_V1` 中的说明一致。
 */
export function sandboxAttachmentManifestV1(
	attachments: readonly Pick<
		SandboxAttachmentV1,
		"name" | "mediaType" | "sizeBytes" | "workspacePath"
	>[],
): string {
	return [
		"Attachments (saved in your workspace; paths are relative to your workspace root):",
		...attachments.map(
			(attachment) =>
				`- name: ${JSON.stringify(attachment.name)}, media type: ${attachment.mediaType}, size: ${attachment.sizeBytes} bytes, path: ${JSON.stringify(attachment.workspacePath)}`,
		),
	].join("\n");
}

/**
 * 原生用户输入的文本：用户消息之后追加清单；正文为空（只有附件）时只发清单。
 * 平台消息本身不改写。
 */
export function sandboxAttachmentPromptTextV1(
	text: string,
	attachments: readonly SandboxAttachmentV1[],
): string {
	if (attachments.length === 0) return text;
	const manifest = sandboxAttachmentManifestV1(attachments);
	return text ? `${text}\n\n${manifest}` : manifest;
}

/** 是否同时作为原生图片输入交给模型。 */
export function isSandboxAttachmentNativeImageV1(
	attachment: Pick<SandboxAttachmentV1, "mediaType">,
): boolean {
	return SANDBOX_ATTACHMENT_NATIVE_IMAGE_TYPES_V1.has(attachment.mediaType);
}

/**
 * 在任何读取之前核对数量；超过单条消息上限时在 native side effect 前拒绝。
 * 同一消息内重复的 fileId 只物化一次。
 */
export function sandboxAttachmentIdsV1(
	fileIds: readonly string[],
	invalid: () => never,
): readonly string[] {
	if (fileIds.length > SANDBOX_ATTACHMENT_MAX_COUNT_V1) invalid();
	return [...new Set(fileIds)];
}

/** 有界取消：不等待一个可能永不结束的上游取消。 */
async function cancelBody(
	body: ReadableStream<Uint8Array> | undefined,
	reader?: ReadableStreamDefaultReader<Uint8Array>,
) {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const cancelling = reader
			? reader.cancel()
			: !body || body.locked
				? Promise.resolve()
				: body.cancel();
		await Promise.race([
			cancelling.then(
				() => undefined,
				() => undefined,
			),
			new Promise<void>((resolve) => {
				timer = setTimeout(resolve, cancelTimeoutMs);
			}),
		]);
	} catch {
		// 已释放或已结束的流无需再取消。
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Linux 上经 `/proc/self/fd/<fd>` 在已打开的目录内操作，等价于 openat：核对之后目录路径被
 * 换成链接也不会改变写入位置。其他平台（本地开发）退回按路径操作，并逐级核对解析结果。
 */
const directoryHandles = process.platform === "linux";

interface DirectoryCursor {
	/** 规范化后的字面路径，只用于返回给原生图片输入与非 Linux 平台的核对。 */
	readonly path: string;
	readonly handle: FileHandle;
}

/** 在目录内操作时使用的路径前缀。 */
function inside(directory: DirectoryCursor) {
	return directoryHandles
		? `/proc/self/fd/${directory.handle.fd}`
		: directory.path;
}

async function openDirectory(via: string, lexical: string) {
	const handle = await open(
		via,
		fsConstants.O_RDONLY |
			(fsConstants.O_DIRECTORY ?? 0) |
			(fsConstants.O_NOFOLLOW ?? 0),
	);
	try {
		if (!(await handle.stat()).isDirectory()) rejected();
		if (!directoryHandles && (await realpath(lexical)) !== lexical) rejected();
		return { path: lexical, handle };
	} catch (error) {
		await handle.close().catch(() => {});
		throw error;
	}
}

/** 打开（按需创建）下一级目录；链接、非目录或解析结果不一致时拒绝。 */
async function openChild(
	parent: DirectoryCursor,
	segment: string,
	create: boolean,
): Promise<DirectoryCursor> {
	const via = join(inside(parent), segment);
	if (create)
		try {
			await mkdir(via, { mode: 0o700 });
		} catch (error) {
			if (errorCode(error) !== "EEXIST") throw error;
		}
	return openDirectory(via, join(parent.path, segment));
}

/**
 * 逐级打开平台目录。部署根（如挂载的 PVC）先规范化；从根到工作区、再到
 * `.agent-infra/attachments/<ref>` 的每一级都必须是真实目录、不能是链接，否则拒绝。
 * 只在工作区内创建目录。
 */
async function platformDirectory(
	root: string,
	workspace: string,
	ref: string,
): Promise<DirectoryCursor> {
	const parts = relative(root, workspace).split(sep);
	if (
		isAbsolute(relative(root, workspace)) ||
		parts.some((part) => part === "" || part === "." || part === "..")
	)
		rejected();
	const base = await realpath(root);
	let current = await openDirectory(base, base);
	try {
		for (const [index, segment] of [
			...parts,
			".agent-infra",
			"attachments",
			ref,
		].entries()) {
			const next = await openChild(current, segment, index >= parts.length);
			await current.handle.close().catch(() => {});
			current = next;
		}
		return current;
	} catch (error) {
		await current.handle.close().catch(() => {});
		throw error;
	}
}

/**
 * 读取已有的平台副本。目标是链接或非普通文件时拒绝；其余无法读取或内容不一致的情况
 * 都按“需要恢复”处理。一致时按需返回读到的字节。
 */
async function readExisting(
	target: string,
	expected: { readonly sizeBytes: number; readonly sha256: string },
	keep: boolean,
): Promise<{ readonly matches: boolean; readonly bytes?: Uint8Array }> {
	let info: Awaited<ReturnType<typeof lstat>>;
	try {
		info = await lstat(target);
	} catch (error) {
		if (errorCode(error) === "ENOENT") return { matches: false };
		throw error;
	}
	if (info.isSymbolicLink() || !info.isFile()) rejected();
	if (info.size !== expected.sizeBytes) return { matches: false };
	let handle: FileHandle;
	try {
		handle = await open(
			target,
			fsConstants.O_RDONLY |
				(fsConstants.O_NOFOLLOW ?? 0) |
				(fsConstants.O_NONBLOCK ?? 0) |
				(fsConstants.O_NOCTTY ?? 0),
		);
	} catch (error) {
		// 核对之后被换成链接同样拒绝；权限被改掉等情况按需要恢复处理。
		if (errorCode(error) === "ELOOP") rejected();
		return { matches: false };
	}
	try {
		const stat = await handle.stat();
		if (!stat.isFile() || stat.size !== expected.sizeBytes)
			return { matches: false };
		const hash = createHash("sha256");
		const chunks: Buffer[] = [];
		const buffer = Buffer.allocUnsafe(readChunkBytes);
		let total = 0;
		for (;;) {
			const { bytesRead } = await handle.read(buffer, 0, buffer.length, total);
			if (bytesRead === 0) break;
			total += bytesRead;
			if (total > expected.sizeBytes) return { matches: false };
			const chunk = buffer.subarray(0, bytesRead);
			hash.update(chunk);
			if (keep) chunks.push(Buffer.from(chunk));
		}
		if (total !== expected.sizeBytes || hash.digest("hex") !== expected.sha256)
			return { matches: false };
		return keep
			? { matches: true, bytes: Buffer.concat(chunks, total) }
			: { matches: true };
	} catch {
		return { matches: false };
	} finally {
		await handle.close().catch(() => {});
	}
}

async function writeFully(handle: FileHandle, chunk: Uint8Array) {
	let offset = 0;
	while (offset < chunk.byteLength) {
		const { bytesWritten } = await handle.write(
			chunk,
			offset,
			chunk.byteLength - offset,
		);
		offset += bytesWritten;
	}
}

/**
 * 在平台目录内写临时文件，按准入描述核对大小与 SHA-256，以只读权限 rename 到目标。
 * 只写这一目录；任何失败都删除临时文件，目标保持原样。
 */
async function writeRestored(
	directory: DirectoryCursor,
	name: string,
	body: ReadableStream<Uint8Array>,
	expected: { readonly sizeBytes: number; readonly sha256: string },
	keep: boolean,
): Promise<Uint8Array | undefined> {
	const temporary = join(inside(directory), `.${randomUUID()}.partial`);
	let handle: FileHandle | undefined = await open(
		temporary,
		fsConstants.O_WRONLY |
			fsConstants.O_CREAT |
			fsConstants.O_EXCL |
			(fsConstants.O_NOFOLLOW ?? 0),
		0o600,
	);
	let renamed = false;
	try {
		const hash = createHash("sha256");
		const chunks: Uint8Array[] = [];
		let total = 0;
		const reader = body.getReader();
		try {
			for (;;) {
				const next = await reader.read();
				if (next.done) break;
				if (!(next.value instanceof Uint8Array)) rejected();
				total += next.value.byteLength;
				if (total > expected.sizeBytes) rejected();
				hash.update(next.value);
				if (keep) chunks.push(next.value);
				await writeFully(handle, next.value);
			}
		} catch (error) {
			await cancelBody(body, reader);
			throw error;
		} finally {
			reader.releaseLock();
		}
		if (total !== expected.sizeBytes || hash.digest("hex") !== expected.sha256)
			rejected();
		// 只读权限仅用于防止误改，不构成安全边界。
		await handle.chmod(0o400);
		await handle.sync();
		await handle.close();
		handle = undefined;
		// 非 Linux 平台按路径操作：rename 之前再次确认平台目录没有被替换。
		if (
			!directoryHandles &&
			(await realpath(directory.path)) !== directory.path
		)
			rejected();
		await rename(temporary, join(inside(directory), name));
		renamed = true;
		return keep ? Buffer.concat(chunks, total) : undefined;
	} finally {
		await handle?.close().catch(() => {});
		if (!renamed) await unlink(temporary).catch(() => {});
	}
}

function validDescriptor(source: RuntimeFileInputV1, fileId: string) {
	const descriptor = source?.descriptor;
	return (
		source?.fileId === fileId &&
		typeof descriptor?.name === "string" &&
		typeof descriptor.mediaType === "string" &&
		Number.isSafeInteger(descriptor.sizeBytes) &&
		descriptor.sizeBytes >= 0 &&
		descriptor.sizeBytes <= SANDBOX_ATTACHMENT_MAX_BYTES_V1 &&
		typeof descriptor.sha256 === "string" &&
		digestPattern.test(descriptor.sha256)
	);
}

/**
 * 按顺序物化本次 Grant 列出的附件。`read` 是请求级 FileBridge 的 `readInput`（Codex 传入
 * 已核对的 Host 临时副本）；`imageBytes` 为 true 时为原生图片输入保留已核对字节。
 * 返回顺序与去重后的 fileId 顺序一致。
 */
export async function materializeSandboxAttachmentsV1(input: {
	/**
	 * 部署提供的 Driver 数据根（可以经挂载点等链接解析）；`workspace` 必须位于其下，
	 * 两者之间的每一级都不能是链接。
	 */
	readonly root: string;
	/** 当前 Conversation 的工作区。 */
	readonly workspace: string;
	readonly fileIds: readonly string[];
	readonly read: (fileId: string) => Promise<RuntimeFileInputV1>;
	readonly invalid: () => never;
	readonly imageBytes?: boolean;
}): Promise<readonly SandboxAttachmentV1[]> {
	const fileIds = sandboxAttachmentIdsV1(input.fileIds, input.invalid);
	const attachments: SandboxAttachmentV1[] = [];
	for (const fileId of fileIds) {
		// FileBridge 的拒绝（未授权、过期、撤权）原样传播。
		const source = await input.read(fileId);
		let directory: DirectoryCursor | undefined;
		try {
			// 超限或不一致的附件不传输、不落盘。
			if (!validDescriptor(source, fileId)) rejected();
			const { descriptor } = source;
			const name = sandboxAttachmentNameV1(
				descriptor.name,
				descriptor.mediaType,
			);
			const ref = sandboxAttachmentRefV1(fileId);
			const keep =
				input.imageBytes === true &&
				SANDBOX_ATTACHMENT_NATIVE_IMAGE_TYPES_V1.has(descriptor.mediaType);
			directory = await platformDirectory(input.root, input.workspace, ref);
			const existing = await readExisting(
				join(inside(directory), name),
				descriptor,
				keep,
			);
			let bytes = existing.bytes;
			if (existing.matches)
				// 内容一致：复用平台副本，不重复写入。
				await cancelBody(source.body);
			else
				bytes = await writeRestored(
					directory,
					name,
					source.body,
					descriptor,
					keep,
				);
			attachments.push({
				name,
				mediaType: descriptor.mediaType,
				sizeBytes: descriptor.sizeBytes,
				workspacePath: posix.join(SANDBOX_ATTACHMENT_DIRECTORY_V1, ref, name),
				path: join(directory.path, name),
				...(bytes ? { imageBytes: bytes } : {}),
			});
		} catch {
			await cancelBody(source?.body);
			input.invalid();
		} finally {
			await directory?.handle.close().catch(() => {});
		}
	}
	return attachments;
}
