import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open, readlink, realpath } from "node:fs/promises";
import { posix, sep } from "node:path";
import {
	type FileDescriptorV1,
	FileDescriptorV1Schema,
	FileProjectionV1Schema,
	parseSandboxReferenceUrlV1,
	SandboxWorkspaceReferenceV1Schema,
} from "@agent-infra/contracts/files";
import type { RuntimeOperationFactV2 } from "@agent-infra/contracts/runtime";
import { inspectFileContentV1 } from "@agent-infra/file-content";
import { fromMarkdown } from "mdast-util-from-markdown";
import { RuntimeHostError } from "./errors.js";
import {
	type RuntimeFileBridgePortV1,
	type RuntimeFileResultReceiptV1,
	RuntimeFileResultUnconfirmedError,
	readRuntimeFileResultReceiptV1,
} from "./runtime-file-bridge.js";

/**
 * #3226：回答内 `sandbox:` 引用的解析、校验与发布（工程 Spec §15.4.4，Runtime HLD 8.5.5）。
 *
 * Driver 在原生 Turn 以 completed 结束、最终回答已确认之后、写终态事件之前调用本模块：
 * 先把解析结果持久保存为发布计划，再逐个引用记录平台中介操作事实
 * （intent → started → completed/failed/unknown），经 FileBridge `writeResult` 发布。
 * 事实只含平台工具标识与受限结果引用，不含路径与文件内容。
 */

/** 结果发布的平台工具标识。 */
export const SANDBOX_RESULT_TOOL_ID_V1 = "workspace.publish_result_file";
/** 每次执行最多发布的引用数。 */
export const SANDBOX_RESULT_MAX_REFERENCES_V1 = 10;
/** Driver 自身的单文件上限；FileLimits 交集由平台在分配结果意图时执行。 */
export const SANDBOX_RESULT_MAX_BYTES_V1 = 50 * 1024 * 1024;

export type SandboxResultPhaseV1 =
	| "pending"
	| "intent"
	| "started"
	| "completed"
	| "failed"
	| "unknown";

/** 发布计划中的一项，保存在 Driver 自己的持久状态中。 */
export interface SandboxResultEntryV1 {
	readonly operationRef: string;
	readonly attemptRef: string;
	/** `reference`：sandbox: 引用或 ACP resource_link；`image`：ACP image 块。 */
	readonly source: "reference" | "image";
	/** 规范化的工作区相对路径；无效引用与 image 块为 null。 */
	readonly workspaceReference: string | null;
	/** 引用本身无效（越界、NUL、反斜杠、工作区外的 resource_link 等）。 */
	readonly rejected?: true;
	phase: SandboxResultPhaseV1;
	/** 保存 intent 时的 descriptor（含大小与 SHA-256），恢复时据此核对内容。 */
	descriptor?: FileDescriptorV1;
	startedAt?: string;
	fileId?: string;
}

export interface SandboxResultPlanV1 {
	readonly schemaVersion: 1;
	readonly entries: SandboxResultEntryV1[];
	/** 超过 10 个的部分合并记为一次失败的发布操作。 */
	overflow?: {
		readonly operationRef: string;
		readonly attemptRef: string;
		phase: "pending" | "failed";
	};
	/** 所有项都已有终态事实，Driver 可以写终态事件。 */
	settled?: true;
}

/** ACP `agent_message_chunk` 中可映射到结果发布的块（流中暂存，Turn 结束时一并处理）。 */
export type SandboxResultBlockV1 =
	| { readonly type: "image"; readonly data: string }
	| { readonly type: "resource_link"; readonly uri: string };

type Candidate =
	| { readonly kind: "reference"; readonly workspaceReference: string }
	| { readonly kind: "invalid"; readonly key: string }
	| { readonly kind: "image"; readonly bytes: Uint8Array | undefined };

interface MarkdownNode {
	readonly type: string;
	readonly url?: string;
	readonly identifier?: string;
	readonly children?: readonly MarkdownNode[];
}

/**
 * 用 CommonMark 解析最终回答，按文档顺序返回 URL 以 `sandbox:` 开头的链接与图片（含引用式
 * 定义）。代码块、行内代码、原始 HTML、普通相对链接和裸路径都不是引用。
 */
export function parseSandboxReferencesV1(
	markdown: string,
): readonly (
	| { readonly kind: "reference"; readonly workspaceReference: string }
	| { readonly kind: "invalid"; readonly url: string }
)[] {
	if (!markdown) return [];
	const root = fromMarkdown(markdown) as unknown as MarkdownNode;
	const definitions = new Map<string, string>();
	const collectDefinitions = (node: MarkdownNode) => {
		if (
			node.type === "definition" &&
			node.identifier !== undefined &&
			node.url !== undefined &&
			// CommonMark：同一标签的第一个定义生效。
			!definitions.has(node.identifier)
		)
			definitions.set(node.identifier, node.url);
		for (const child of node.children ?? []) collectDefinitions(child);
	};
	collectDefinitions(root);
	const found: (
		| { kind: "reference"; workspaceReference: string }
		| { kind: "invalid"; url: string }
	)[] = [];
	const visit = (node: MarkdownNode) => {
		const url =
			node.type === "link" || node.type === "image"
				? node.url
				: (node.type === "linkReference" || node.type === "imageReference") &&
						node.identifier !== undefined
					? definitions.get(node.identifier)
					: undefined;
		if (url !== undefined) {
			const parsed = parseSandboxReferenceUrlV1(url);
			if (parsed.kind === "reference")
				found.push({
					kind: "reference",
					workspaceReference: parsed.workspaceReference,
				});
			else if (parsed.kind === "invalid") found.push({ kind: "invalid", url });
		}
		for (const child of node.children ?? []) visit(child);
	};
	visit(root);
	return found;
}

/**
 * 把 ACP `resource_link` 的 URI 映射为工作区引用：只接受 `file:` scheme、authority 为空、
 * 百分号解码后位于工作区根目录内的绝对路径。其他 scheme 返回 undefined（不是引用）；
 * 带主机、工作区外或无法解析的 `file:` URI 返回 invalid。
 */
export function parseSandboxResourceLinkV1(
	uri: string,
	workspaceRoot: string,
):
	| undefined
	| { readonly kind: "reference"; readonly workspaceReference: string }
	| { readonly kind: "invalid" } {
	if (!/^file:/i.test(uri)) return undefined;
	let rest = uri.slice("file:".length);
	if (rest.startsWith("//")) {
		const end = rest.indexOf("/", 2);
		const authority = end === -1 ? rest.slice(2) : rest.slice(2, end);
		if (authority !== "" || end === -1) return { kind: "invalid" };
		rest = rest.slice(2);
	}
	if (!rest.startsWith("/") || rest.includes("?") || rest.includes("#"))
		return { kind: "invalid" };
	let decoded: string;
	try {
		decoded = decodeURIComponent(rest);
	} catch {
		return { kind: "invalid" };
	}
	if (decoded.includes("\0") || decoded.includes("\\"))
		return { kind: "invalid" };
	const root = posix.normalize(workspaceRoot.split(sep).join("/"));
	const relative = posix.relative(root, posix.normalize(decoded));
	if (
		!relative ||
		relative === ".." ||
		relative.startsWith("../") ||
		posix.isAbsolute(relative) ||
		!SandboxWorkspaceReferenceV1Schema.safeParse(relative).success
	)
		return { kind: "invalid" };
	return { kind: "reference", workspaceReference: relative };
}

function decodeImage(data: string): Uint8Array | undefined {
	// base64 长度按 4/3 估算，超出单文件上限时不解码。
	if (
		data.length === 0 ||
		data.length > Math.ceil(SANDBOX_RESULT_MAX_BYTES_V1 / 3) * 4 ||
		!/^[A-Za-z0-9+/]+={0,2}$/.test(data) ||
		data.length % 4 !== 0
	)
		return undefined;
	return Buffer.from(data, "base64");
}

/**
 * 根据最终回答（以及 ACP 块）生成发布计划：按首次出现的顺序、以规范化路径去重，前 10 项
 * 逐个发布，其余合并记为一次失败。image 块的字节只在内存中保留，按 operationRef 返回。
 */
export function planSandboxResultsV1(input: {
	readonly text?: string;
	readonly blocks?: readonly SandboxResultBlockV1[];
	readonly workspaceRoot?: string;
}): {
	readonly plan: SandboxResultPlanV1 | undefined;
	readonly images: ReadonlyMap<string, Uint8Array>;
} {
	const candidates: Candidate[] = [];
	const seen = new Set<string>();
	const add = (candidate: Candidate, key: string) => {
		if (seen.has(key)) return;
		seen.add(key);
		candidates.push(candidate);
	};
	for (const item of parseSandboxReferencesV1(input.text ?? "")) {
		if (item.kind === "reference")
			add(item, `reference:${item.workspaceReference}`);
		else add({ kind: "invalid", key: item.url }, `invalid:${item.url}`);
	}
	for (const block of input.blocks ?? []) {
		if (block.type === "image") {
			const bytes = decodeImage(block.data);
			const digest = bytes
				? createHash("sha256").update(bytes).digest("hex")
				: createHash("sha256").update(block.data).digest("hex");
			add({ kind: "image", bytes }, `image:${digest}`);
			continue;
		}
		const parsed = input.workspaceRoot
			? parseSandboxResourceLinkV1(block.uri, input.workspaceRoot)
			: /^file:/i.test(block.uri)
				? ({ kind: "invalid" } as const)
				: undefined;
		if (!parsed) continue;
		if (parsed.kind === "reference")
			add(parsed, `reference:${parsed.workspaceReference}`);
		else add({ kind: "invalid", key: block.uri }, `invalid:${block.uri}`);
	}
	if (candidates.length === 0) return { plan: undefined, images: new Map() };
	const images = new Map<string, Uint8Array>();
	const entries = candidates
		.slice(0, SANDBOX_RESULT_MAX_REFERENCES_V1)
		.map((candidate): SandboxResultEntryV1 => {
			const operationRef = randomUUID();
			const base = {
				operationRef,
				attemptRef: randomUUID(),
				phase: "pending" as const,
			};
			if (candidate.kind === "reference")
				return {
					...base,
					source: "reference",
					workspaceReference: candidate.workspaceReference,
				};
			if (candidate.kind === "image") {
				if (candidate.bytes) images.set(operationRef, candidate.bytes);
				return {
					...base,
					source: "image",
					workspaceReference: null,
					...(candidate.bytes ? {} : { rejected: true as const }),
				};
			}
			return {
				...base,
				source: "reference",
				workspaceReference: null,
				rejected: true,
			};
		});
	return {
		plan: {
			schemaVersion: 1,
			entries,
			...(candidates.length > SANDBOX_RESULT_MAX_REFERENCES_V1
				? {
						overflow: {
							operationRef: randomUUID(),
							attemptRef: randomUUID(),
							phase: "pending" as const,
						},
					}
				: {}),
		},
		images,
	};
}

/** 校验从 Driver 持久状态读回的发布计划；形状不符时返回 false。 */
export function isSandboxResultPlanV1(
	value: unknown,
): value is SandboxResultPlanV1 {
	if (!isRecord(value) || value.schemaVersion !== 1) return false;
	if (
		Object.keys(value).some(
			(key) =>
				!["schemaVersion", "entries", "overflow", "settled"].includes(key),
		) ||
		(value.settled !== undefined && value.settled !== true) ||
		!Array.isArray(value.entries) ||
		value.entries.length > SANDBOX_RESULT_MAX_REFERENCES_V1
	)
		return false;
	if (
		value.overflow !== undefined &&
		(!isRecord(value.overflow) ||
			Object.keys(value.overflow).some(
				(key) => !["operationRef", "attemptRef", "phase"].includes(key),
			) ||
			!isRef(value.overflow.operationRef) ||
			!isRef(value.overflow.attemptRef) ||
			(value.overflow.phase !== "pending" && value.overflow.phase !== "failed"))
	)
		return false;
	return value.entries.every(
		(entry) =>
			isRecord(entry) &&
			Object.keys(entry).every((key) =>
				[
					"operationRef",
					"attemptRef",
					"source",
					"workspaceReference",
					"rejected",
					"phase",
					"descriptor",
					"startedAt",
					"fileId",
				].includes(key),
			) &&
			isRef(entry.operationRef) &&
			isRef(entry.attemptRef) &&
			(entry.source === "reference" || entry.source === "image") &&
			(entry.workspaceReference === null ||
				SandboxWorkspaceReferenceV1Schema.safeParse(entry.workspaceReference)
					.success) &&
			(entry.rejected === undefined || entry.rejected === true) &&
			[
				"pending",
				"intent",
				"started",
				"completed",
				"failed",
				"unknown",
			].includes(entry.phase as string) &&
			(entry.descriptor === undefined ||
				FileDescriptorV1Schema.safeParse(entry.descriptor).success) &&
			(entry.startedAt === undefined || typeof entry.startedAt === "string") &&
			(entry.fileId === undefined || isRef(entry.fileId)),
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRef(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= 255;
}

function within(root: string, candidate: string) {
	return candidate === root || candidate.startsWith(`${root}${sep}`);
}

/**
 * 按工作区引用读取一个普通文件：以 `O_NOFOLLOW` 打开，之后的读取、类型识别与 SHA-256 都使用
 * 同一个文件描述符读到的字节，不再按路径重新打开。任何一项不满足都返回 undefined。
 */
export async function readSandboxResultFileV1(
	workspaceRoot: string,
	workspaceReference: string,
	maxBytes = SANDBOX_RESULT_MAX_BYTES_V1,
): Promise<
	| { readonly descriptor: FileDescriptorV1; readonly bytes: Uint8Array }
	| undefined
> {
	if (!SandboxWorkspaceReferenceV1Schema.safeParse(workspaceReference).success)
		return undefined;
	const root = await realpath(workspaceRoot).catch(() => undefined);
	if (!root) return undefined;
	const segments = workspaceReference.split("/");
	const name = segments.at(-1);
	if (!name) return undefined;
	// 父目录逐级不得是链接：解析结果必须与工作区内的字面路径完全一致，指回工作区内的
	// 链接目录同样拒绝。
	const lexicalParent = [root, ...segments.slice(0, -1)].join(sep);
	const parent = await realpath(lexicalParent).catch(() => undefined);
	if (!parent || parent !== lexicalParent || !within(root, parent))
		return undefined;
	const target = `${parent}${sep}${name}`;
	const handle = await open(
		target,
		fsConstants.O_RDONLY |
			(fsConstants.O_NOFOLLOW ?? 0) |
			(fsConstants.O_NONBLOCK ?? 0) |
			(fsConstants.O_NOCTTY ?? 0),
	).catch(() => undefined);
	if (!handle) return undefined;
	try {
		const stat = await handle.stat();
		if (!stat.isFile() || stat.size > maxBytes) return undefined;
		// 打开之后再确认描述符仍指向同一路径上的同一文件，防止父目录在核对后被替换。
		if (process.platform === "linux") {
			const opened = await readlink(`/proc/self/fd/${handle.fd}`).catch(
				() => undefined,
			);
			if (opened !== target) return undefined;
		} else {
			const current = await lstat(target).catch(() => undefined);
			const currentParent = await realpath(parent).catch(() => undefined);
			if (
				!current ||
				current.ino !== stat.ino ||
				current.dev !== stat.dev ||
				currentParent !== parent
			)
				return undefined;
		}
		const chunks: Buffer[] = [];
		let total = 0;
		const buffer = Buffer.allocUnsafe(64 * 1024);
		for (;;) {
			const { bytesRead } = await handle.read(buffer, 0, buffer.length, total);
			if (bytesRead === 0) break;
			total += bytesRead;
			if (total > maxBytes) return undefined;
			chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
		}
		const bytes = Buffer.concat(chunks, total);
		const descriptor = await describe(bytes, name, maxBytes);
		return descriptor ? { descriptor, bytes } : undefined;
	} finally {
		await handle.close().catch(() => {});
	}
}

async function describe(
	bytes: Uint8Array,
	name: string,
	maxBytes: number,
): Promise<FileDescriptorV1 | undefined> {
	try {
		const facts = await inspectFileContentV1(bytes, maxBytes);
		const parsed = FileDescriptorV1Schema.safeParse({ name, ...facts });
		return parsed.success ? parsed.data : undefined;
	} catch {
		return undefined;
	}
}

function sameDescriptor(left: FileDescriptorV1, right: FileDescriptorV1) {
	return (
		left.name === right.name &&
		left.mediaType === right.mediaType &&
		left.sizeBytes === right.sizeBytes &&
		left.sha256 === right.sha256
	);
}

/** ACP image 块没有文件名，按识别出的类型给一个稳定名称。 */
function imageName(mediaType: string, sha256: string) {
	const extension =
		mediaType.split("/")[1]?.replace(/[^a-z0-9]+/g, "") || "bin";
	return `image-${sha256.slice(0, 12)}.${extension}`;
}

/** Driver 提供的持久化端口：一次提交内替换计划、追加事实，并在给出回执时记录结果文件事件。 */
export interface SandboxResultLedgerV1 {
	read(): SandboxResultPlanV1 | undefined;
	commit(change: {
		readonly plan: SandboxResultPlanV1;
		readonly facts: readonly RuntimeOperationFactV2[];
		readonly receipt?: RuntimeFileResultReceiptV1;
	}): Promise<void>;
}

function toolFact(
	entry: { readonly operationRef: string; readonly attemptRef: string },
	phase: RuntimeOperationFactV2["phase"],
	details: Partial<
		Pick<
			Extract<RuntimeOperationFactV2, { kind: "tool" }>,
			"startedAt" | "finishedAt" | "durationMs" | "failureCode" | "resultRef"
		>
	> = {},
): RuntimeOperationFactV2 {
	return {
		kind: "tool",
		operationRef: entry.operationRef,
		attemptRef: entry.attemptRef,
		phase,
		toolId: SANDBOX_RESULT_TOOL_ID_V1,
		...details,
	};
}

function finished(entry: SandboxResultEntryV1, now: number) {
	const startedMs = entry.startedAt ? Date.parse(entry.startedAt) : Number.NaN;
	return {
		finishedAt: new Date(now).toISOString(),
		...(Number.isFinite(startedMs)
			? { startedAt: entry.startedAt, durationMs: Math.max(0, now - startedMs) }
			: {}),
	};
}

function clonePlan(plan: SandboxResultPlanV1): SandboxResultPlanV1 {
	return structuredClone(plan);
}

/**
 * 没有可用的 FileBridge（Host 重启后不重建执行期文件交换上下文，或部署未装配）时，沿已保存
 * 的进度收敛：未开始的项记失败；已开始但没有结论的项，若 journal 中已有同一引用的结果文件
 * 事件则记完成，否则保持 unknown。不重发、不新建意图。
 */
export function settleSandboxResultsWithoutBridgeV1(
	input: SandboxResultPlanV1,
	confirmedFileId: (entry: SandboxResultEntryV1) => string | undefined,
	now = Date.now(),
): { plan: SandboxResultPlanV1; facts: RuntimeOperationFactV2[] } {
	const plan = clonePlan(input);
	const facts: RuntimeOperationFactV2[] = [];
	if (plan.overflow?.phase === "pending") {
		facts.push(
			toolFact(plan.overflow, "intent"),
			toolFact(plan.overflow, "failed", {
				finishedAt: new Date(now).toISOString(),
				failureCode: "request_rejected",
			}),
		);
		plan.overflow.phase = "failed";
	}
	for (const entry of plan.entries) {
		if (entry.phase === "pending" || entry.phase === "intent") {
			if (entry.phase === "pending") facts.push(toolFact(entry, "intent"));
			facts.push(
				toolFact(entry, "failed", {
					finishedAt: new Date(now).toISOString(),
					failureCode: entry.rejected
						? "request_rejected"
						: "dependency_unavailable",
				}),
			);
			entry.phase = "failed";
		} else if (entry.phase === "started") {
			const fileId = confirmedFileId(entry);
			if (fileId) {
				facts.push(
					toolFact(entry, "completed", {
						...finished(entry, now),
						resultRef: fileId,
					}),
				);
				entry.phase = "completed";
				entry.fileId = fileId;
			} else {
				facts.push(
					toolFact(entry, "unknown", {
						...finished(entry, now),
						failureCode: "recovery_unconfirmed",
					}),
				);
				entry.phase = "unknown";
			}
		}
	}
	plan.settled = true;
	return { plan, facts };
}

function failureCodeFor(
	error: unknown,
): NonNullable<RuntimeOperationFactV2["failureCode"]> {
	// 当前执行授权失效（停止、撤权、代次变化）或桥接上下文被撤销。
	if (
		(error instanceof RuntimeHostError && error.httpStatus === 403) ||
		(error instanceof Error &&
			/RUNTIME_FILE_BRIDGE_CONTEXT_(REVOKED|STALE)/.test(error.message))
	)
		return "authorization_denied";
	// 平台拒绝分配结果意图（FileLimits 不允许的类型或大小、授权不符等）。
	if (
		error instanceof Error &&
		error.message === "RUNTIME_FILE_EXCHANGE_UNAVAILABLE"
	)
		return "request_rejected";
	return "operation_failed";
}

/**
 * 按持久计划逐项发布。每一步先提交再继续：intent（含 descriptor）→ started → writeResult →
 * completed/failed/unknown。已开始但本进程没有结论的项（例如上一轮提交失败）保持 unknown。
 * 恢复时重新打开文件，内容与原 intent 的 descriptor 不一致记失败，不改发新内容。
 */
export async function publishSandboxResultsV1(input: {
	readonly ledger: SandboxResultLedgerV1;
	readonly bridge: RuntimeFileBridgePortV1 | undefined;
	readonly workspaceRoot: string | undefined;
	readonly images?: ReadonlyMap<string, Uint8Array>;
	readonly now?: () => number;
}): Promise<void> {
	const now = input.now ?? Date.now;
	const current = input.ledger.read();
	if (!current || current.settled) return;
	if (!input.bridge || !input.workspaceRoot) {
		const settled = settleSandboxResultsWithoutBridgeV1(
			current,
			() => undefined,
			now(),
		);
		await input.ledger.commit(settled);
		return;
	}
	const bridge = input.bridge;
	const root = input.workspaceRoot;
	let plan = clonePlan(current);
	const commit = async (
		facts: RuntimeOperationFactV2[],
		receipt?: RuntimeFileResultReceiptV1,
	) => {
		await input.ledger.commit({
			plan,
			facts,
			...(receipt ? { receipt } : {}),
		});
		plan = clonePlan(plan);
	};
	if (plan.overflow?.phase === "pending") {
		plan.overflow.phase = "failed";
		await commit([
			toolFact(plan.overflow, "intent"),
			toolFact(plan.overflow, "failed", {
				finishedAt: new Date(now()).toISOString(),
				failureCode: "request_rejected",
			}),
		]);
	}
	for (let index = 0; index < plan.entries.length; index++) {
		const entry = () => plan.entries[index] as SandboxResultEntryV1;
		const original = entry();
		if (
			original.phase === "completed" ||
			original.phase === "failed" ||
			original.phase === "unknown"
		)
			continue;
		if (original.phase === "started") {
			// 本进程没有该次 writeResult 的结论：不重发，保持 unknown。
			entry().phase = "unknown";
			await commit([
				toolFact(original, "unknown", {
					...finished(original, now()),
					failureCode: "recovery_unconfirmed",
				}),
			]);
			continue;
		}
		const fail = async (
			failureCode: NonNullable<RuntimeOperationFactV2["failureCode"]>,
			withIntent: boolean,
		) => {
			const facts = [
				...(withIntent ? [toolFact(entry(), "intent")] : []),
				toolFact(entry(), "failed", {
					...finished(entry(), now()),
					failureCode,
				}),
			];
			entry().phase = "failed";
			await commit(facts);
		};
		if (original.rejected) {
			await fail("request_rejected", original.phase === "pending");
			continue;
		}
		let content:
			| { readonly descriptor: FileDescriptorV1; readonly bytes: Uint8Array }
			| undefined;
		if (original.source === "image") {
			const bytes = input.images?.get(original.operationRef);
			const facts = bytes
				? await inspectFileContentV1(bytes, SANDBOX_RESULT_MAX_BYTES_V1).catch(
						() => undefined,
					)
				: undefined;
			const parsed = facts
				? FileDescriptorV1Schema.safeParse({
						name: imageName(facts.mediaType, facts.sha256),
						...facts,
					})
				: undefined;
			content =
				bytes && parsed?.success
					? { descriptor: parsed.data, bytes }
					: undefined;
		} else if (original.workspaceReference) {
			content = await readSandboxResultFileV1(
				root,
				original.workspaceReference,
			);
		}
		if (
			!content ||
			(original.descriptor &&
				!sameDescriptor(original.descriptor, content.descriptor))
		) {
			await fail(
				original.source === "image" && original.phase === "intent"
					? "dependency_unavailable"
					: "request_rejected",
				original.phase === "pending",
			);
			continue;
		}
		if (original.phase === "pending") {
			entry().phase = "intent";
			entry().descriptor = content.descriptor;
			await commit([toolFact(entry(), "intent")]);
		}
		const startedAt = new Date(now()).toISOString();
		entry().phase = "started";
		entry().startedAt = startedAt;
		await commit([toolFact(entry(), "started", { startedAt })]);
		const bytes = content.bytes;
		let receipt: RuntimeFileResultReceiptV1;
		try {
			receipt = await bridge.writeResult(
				content.descriptor,
				new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(bytes);
						controller.close();
					},
				}),
				{ workspaceReference: original.workspaceReference },
			);
		} catch (error) {
			const unconfirmed = error instanceof RuntimeFileResultUnconfirmedError;
			entry().phase = unconfirmed ? "unknown" : "failed";
			await commit([
				toolFact(entry(), unconfirmed ? "unknown" : "failed", {
					...finished(entry(), now()),
					failureCode: unconfirmed
						? "recovery_unconfirmed"
						: failureCodeFor(error),
				}),
			]);
			continue;
		}
		let fileId: string | undefined;
		try {
			const { projection, workspaceReference } =
				readRuntimeFileResultReceiptV1(receipt);
			const parsed = FileProjectionV1Schema.parse(projection);
			if (
				parsed.kind === "result" &&
				parsed.status === "available" &&
				sameDescriptor(parsed.descriptor, content.descriptor) &&
				(workspaceReference ?? null) === original.workspaceReference
			)
				fileId = parsed.fileId;
		} catch {
			fileId = undefined;
		}
		if (!fileId) {
			// 平台返回了无法核对的回执：对象可能已确认，只能保持 unknown。
			entry().phase = "unknown";
			await commit([
				toolFact(entry(), "unknown", {
					...finished(entry(), now()),
					failureCode: "recovery_unconfirmed",
				}),
			]);
			continue;
		}
		entry().phase = "completed";
		entry().fileId = fileId;
		await commit(
			[
				toolFact(entry(), "completed", {
					...finished(entry(), now()),
					resultRef: fileId,
				}),
			],
			receipt,
		);
	}
	plan.settled = true;
	await commit([]);
}

/** 拼接最终回答：本次执行已确认的全部文本事件，按顺序。 */
export function sandboxResultAnswerText(
	events: readonly { readonly type: string; readonly payload: unknown }[],
): string {
	return events
		.flatMap((event) =>
			event.type === "text" &&
			isRecord(event.payload) &&
			typeof event.payload.delta === "string"
				? [event.payload.delta]
				: [],
		)
		.join("");
}
